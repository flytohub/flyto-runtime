import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerConfig } from "../config.js";
import {
  normalizeCloudJob,
  type Flyto2Assignment,
  type Flyto2RuntimeManifest,
} from "./protocol.js";

const DEFAULT_CLOUD_URL = "https://api.flyto2.com";
const CREDENTIAL_FILE = "flyto2-cloud.json";
const EMPTY_WAIT_FLOOR_MS = 1_000;
const ERROR_BACKOFF_BASE_MS = 3_000;
const ERROR_BACKOFF_MAX_MS = 30_000;

export interface Flyto2CloudCredentials {
  cloud_url: string;
  device_id: string;
  device_secret: string;
  workspace_id: string;
  workspace_name?: string;
  space_id?: string;
  paired_at: string;
}

export interface Flyto2ClaimReceipt {
  lease_id: string;
  lease_expires_at?: string | number | null;
}

export interface Flyto2Progress {
  current_step_index?: number;
  total_steps?: number;
  current_node_id?: string;
  status?: string;
  step_result?: Record<string, unknown>;
  step_id?: string;
}

export interface Flyto2Completion {
  status: "success" | "failed";
  error_message?: string;
  variables?: Record<string, unknown>;
  node_outputs?: Record<string, unknown>;
  failure?: {
    code: string;
    capability?: string;
    retryable_elsewhere?: boolean;
    detail?: string;
  };
}

export class Flyto2CloudBridge {
  private readonly credentialPath: string;
  private credentials?: Flyto2CloudCredentials;

  constructor(
    private readonly config: Pick<ServerConfig, "stateDir">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.credentialPath = join(config.stateDir, CREDENTIAL_FILE);
    this.credentials = this.readCredentials();
  }

  get paired(): boolean {
    return Boolean(this.credentials);
  }

  get workspaceId(): string | undefined {
    return this.credentials?.workspace_id;
  }

  get deviceId(): string | undefined {
    return this.credentials?.device_id;
  }

  get spaceId(): string | undefined {
    return this.credentials?.space_id;
  }

  async pair(
    pairingCode: string,
    manifest: Flyto2RuntimeManifest,
    cloudUrl = DEFAULT_CLOUD_URL,
  ): Promise<Flyto2CloudCredentials> {
    const code = pairingCode.trim();
    if (!code) throw new Error("Pairing code is required.");
    const normalizedCloudUrl = normalizeCloudUrl(cloudUrl);
    const response = await this.fetchImpl(
      normalizedCloudUrl + "/api/devices/pair/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairing_code: code,
          name: manifest.display_name,
          platform: manifest.platform,
          version: manifest.runtime_version,
          roles: manifest.roles,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Flyto2 Cloud pairing failed: HTTP ${response.status}`);
    }
    const body = await response.json() as Record<string, unknown>;
    const deviceId = requiredString(body, "device_id");
    const deviceSecret = requiredString(body, "device_secret");
    const workspaceId = requiredString(body, "workspace_id");
    const credentials: Flyto2CloudCredentials = {
      cloud_url: normalizedCloudUrl,
      device_id: deviceId,
      device_secret: deviceSecret,
      workspace_id: workspaceId,
      workspace_name: optionalString(body, "workspace_name"),
      space_id: optionalString(body, "space_id"),
      paired_at: new Date().toISOString(),
    };
    this.writeCredentials(credentials);
    this.credentials = credentials;
    return credentials;
  }

  async heartbeat(signal?: AbortSignal): Promise<void> {
    const credentials = this.requireCredentials();
    const response = await this.request(
      `/api/devices/${encodeURIComponent(credentials.device_id)}/heartbeat`,
      { method: "POST", body: JSON.stringify({}), signal },
    );
    ensureSuccess(response, "heartbeat");
  }

  async waitForAssignment(signal?: AbortSignal): Promise<Flyto2Assignment | undefined> {
    const credentials = this.requireCredentials();
    const startedAt = Date.now();
    const response = await this.request(
      "/api/devices/jobs/poll?wait_seconds=25",
      {
        method: "POST",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(35_000)])
          : AbortSignal.timeout(35_000),
      },
    );
    ensureSuccess(response, "assignment wait");
    const body = await response.json() as Record<string, unknown>;
    const job = body.job;
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      const elapsed = Date.now() - startedAt;
      if (elapsed < EMPTY_WAIT_FLOOR_MS) {
        await delay(EMPTY_WAIT_FLOOR_MS - elapsed, signal);
      }
      return undefined;
    }
    return normalizeCloudJob(job as Record<string, unknown>, credentials.workspace_id);
  }

  async claim(assignmentId: string, signal?: AbortSignal): Promise<Flyto2ClaimReceipt> {
    const response = await this.request(
      `/api/devices/jobs/${encodeURIComponent(assignmentId)}/claim`,
      { method: "POST", signal },
    );
    ensureSuccess(response, "assignment claim");
    const body = await response.json() as Record<string, unknown>;
    return {
      lease_id: requiredString(body, "lease_id"),
      lease_expires_at: body.lease_expires_at as string | number | null | undefined,
    };
  }

  async renewLease(
    assignmentId: string,
    leaseId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.request(
      `/api/devices/jobs/${encodeURIComponent(assignmentId)}/lease`,
      {
        method: "POST",
        headers: { "X-Flyto-Lease": leaseId },
        signal,
      },
    );
    ensureSuccess(response, "lease renewal");
  }

  async reportProgress(
    assignmentId: string,
    leaseId: string,
    progress: Flyto2Progress,
    signal?: AbortSignal,
  ): Promise<{ cancel_requested: boolean }> {
    const response = await this.request(
      `/api/devices/jobs/${encodeURIComponent(assignmentId)}/progress`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Flyto-Lease": leaseId,
        },
        body: JSON.stringify(progress),
        signal,
      },
    );
    ensureSuccess(response, "progress report");
    const body = await response.json() as Record<string, unknown>;
    return { cancel_requested: body.cancel_requested === true };
  }

  async complete(
    assignmentId: string,
    leaseId: string,
    completion: Flyto2Completion,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.request(
      `/api/devices/jobs/${encodeURIComponent(assignmentId)}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Flyto-Lease": leaseId,
        },
        body: JSON.stringify(completion),
        signal,
      },
    );
    ensureSuccess(response, "completion report");
  }

  async runAssignmentLoop(
    onAssignment: (assignment: Flyto2Assignment) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    let backoffMs = ERROR_BACKOFF_BASE_MS;
    while (!signal?.aborted) {
      try {
        const assignment = await this.waitForAssignment(signal);
        backoffMs = ERROR_BACKOFF_BASE_MS;
        if (assignment) await onAssignment(assignment);
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return;
        await delay(jitter(backoffMs), signal);
        backoffMs = Math.min(backoffMs * 2, ERROR_BACKOFF_MAX_MS);
      }
    }
  }

  private async request(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const credentials = this.requireCredentials();
    const headers = new Headers(init.headers);
    headers.set(
      "authorization",
      `Bearer device:${credentials.device_id}.${credentials.device_secret}`,
    );
    return this.fetchImpl(credentials.cloud_url + path, {
      ...init,
      headers,
    });
  }

  private requireCredentials(): Flyto2CloudCredentials {
    if (!this.credentials) {
      throw new Error("Flyto2 Runtime is not paired with Flyto2 Cloud.");
    }
    return this.credentials;
  }

  private readCredentials(): Flyto2CloudCredentials | undefined {
    if (!existsSync(this.credentialPath)) return undefined;
    const value = JSON.parse(readFileSync(this.credentialPath, "utf8")) as Partial<Flyto2CloudCredentials>;
    if (!value.device_id || !value.device_secret || !value.workspace_id || !value.cloud_url) {
      throw new Error(`Malformed Flyto2 Cloud credential file: ${this.credentialPath}`);
    }
    return {
      cloud_url: normalizeCloudUrl(value.cloud_url),
      device_id: value.device_id,
      device_secret: value.device_secret,
      workspace_id: value.workspace_id,
      workspace_name: value.workspace_name,
      space_id: value.space_id,
      paired_at: value.paired_at ?? "",
    };
  }

  private writeCredentials(credentials: Flyto2CloudCredentials): void {
    mkdirSync(dirname(this.credentialPath), { recursive: true, mode: 0o700 });
    const temp = this.credentialPath + ".tmp";
    writeFileSync(temp, JSON.stringify(credentials, null, 2) + "\n", {
      mode: 0o600,
      flag: "w",
    });
    renameSync(temp, this.credentialPath);
    chmodSync(this.credentialPath, 0o600);
  }
}

function normalizeCloudUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Flyto2 Cloud URL must use HTTPS outside localhost.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value, key);
  if (!result) throw new Error(`Flyto2 Cloud response is missing ${key}.`);
  return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function ensureSuccess(response: Response, operation: string): void {
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Flyto2 Cloud ${operation} refused the paired device credential.`);
  }
  if (!response.ok) {
    throw new Error(`Flyto2 Cloud ${operation} failed: HTTP ${response.status}`);
  }
}

function jitter(delayMs: number): number {
  return Math.max(1, Math.round(delayMs / 2 + Math.random() * delayMs / 2));
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
