import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Request } from "express";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import type { RuntimeEvent, RuntimeEventStore } from "./runtime-events.js";

const MCP_EVENTS_VERSION = "2026-07-28";
const DEFAULT_SUBSCRIPTION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SUBSCRIPTION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const CALLBACK_TIMEOUT_MS = 10_000;

const EVENT_NAMES = [
  "process.completed",
  "process.failed",
  "process.stalled",
  "task.needs_attention",
] as const;

type SupportedEventName = typeof EVENT_NAMES[number];

export interface JsonRpcRequestLike {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponseLike {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

interface McpEventSubscriptionRow {
  id: string;
  principal: string;
  name: SupportedEventName;
  arguments_json: string;
  callback_url: string;
  signing_secret: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
  verified_at: string;
  expires_at: string;
}

interface McpEventSubscription {
  id: string;
  principal: string;
  name: SupportedEventName;
  arguments: Record<string, string>;
  callbackUrl: string;
  signingSecret: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  verifiedAt: string;
  expiresAt: string;
}

export interface McpEventWebhookResponse {
  status: number;
  body: string;
}

export type McpEventWebhookPost = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<McpEventWebhookResponse>;

/**
 * Draft MCP Events compatibility service for ChatGPT. It deliberately sits
 * beside the MCP SDK so tool handling remains unchanged while event methods can
 * track the 2026-07-28 draft before the SDK exposes them natively.
 */
export class McpEventService {
  private readonly database: DatabaseHandle;
  private readonly detachRuntimeEvents: () => void;
  private closed = false;

  constructor(
    stateDir: string,
    private readonly runtimeEvents: RuntimeEventStore,
    private readonly webhookPost: McpEventWebhookPost = secureWebhookPost,
  ) {
    this.database = openDatabase(stateDir);
    this.detachRuntimeEvents = this.runtimeEvents.onEvent((event) => {
      if (!isSupportedEventName(event.type)) return;
      void this.deliverRuntimeEvent(event).catch(() => {
        // Event state remains durable in Runtime. Webhook delivery is retried
        // below and future Runtime recovery remains the final fallback.
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachRuntimeEvents();
    this.database.close();
  }

  async handle(
    request: JsonRpcRequestLike | undefined,
    principal: string,
  ): Promise<JsonRpcResponseLike | undefined> {
    if (!request || typeof request !== "object" || Array.isArray(request)) return undefined;
    const id = request.id ?? null;
    switch (request.method) {
      case "server/discover":
        return ok(id, {
          resultType: "complete",
          supportedVersions: [MCP_EVENTS_VERSION],
          capabilities: { tools: {}, events: {} },
        });
      case "events/list":
        return ok(id, { events: eventDefinitions() });
      case "events/subscribe":
        return this.subscribe(id, principal, request.params);
      case "events/unsubscribe":
        return this.unsubscribe(id, principal, request.params);
      default:
        return undefined;
    }
  }

  private async subscribe(
    id: string | number | null,
    principal: string,
    raw: unknown,
  ): Promise<JsonRpcResponseLike> {
    const parsed = parseSubscriptionParams(raw, true);
    if ("error" in parsed) return rpcError(id, -32602, parsed.error);

    const { name, arguments: args, delivery, ttlMs } = parsed;
    if (!isSupportedEventName(name)) return rpcError(id, -32602, "Unsupported event name.");
    const secretError = validateSigningSecret(delivery.secret ?? "");
    if (secretError) return rpcError(id, -32602, secretError);

    const canonicalArguments = canonicalJson(args);
    const subscriptionId = deterministicSubscriptionId(
      principal,
      delivery.url,
      name,
      canonicalArguments,
    );
    try {
      validateCallbackUrl(delivery.url);
      await verifyCallback(delivery.url, delivery.secret!, subscriptionId, this.webhookPost);
    } catch (error) {
      return rpcError(id, -32015, "Callback endpoint verification failed.", {
        reason: callbackFailureReason(error),
      });
    }
    const now = new Date();
    const ttl = normalizeTtlMs(ttlMs);
    const expiresAt = new Date(now.getTime() + ttl).toISOString();
    this.database.sqlite.prepare(
      `insert into flyto2_mcp_event_subscriptions (
         id, principal, name, arguments_json, callback_url, signing_secret,
         status, created_at, updated_at, verified_at, expires_at
       ) values (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
       on conflict(id) do update set
         signing_secret = excluded.signing_secret,
         status = 'active',
         updated_at = excluded.updated_at,
         verified_at = excluded.verified_at,
         expires_at = excluded.expires_at`,
    ).run(
      subscriptionId,
      principal,
      name,
      canonicalArguments,
      delivery.url,
      delivery.secret,
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      expiresAt,
    );
    return ok(id, {
      id: subscriptionId,
      refreshBefore: expiresAt,
      cursor: null,
      truncated: false,
    });
  }

  private unsubscribe(
    id: string | number | null,
    principal: string,
    raw: unknown,
  ): JsonRpcResponseLike {
    const parsed = parseSubscriptionParams(raw, false);
    if ("error" in parsed) return rpcError(id, -32602, parsed.error);
    if (!isSupportedEventName(parsed.name)) return ok(id, {});
    const canonicalArguments = canonicalJson(parsed.arguments);
    const subscriptionId = deterministicSubscriptionId(
      principal,
      parsed.delivery.url,
      parsed.name,
      canonicalArguments,
    );
    this.database.sqlite.prepare(
      `delete from flyto2_mcp_event_subscriptions where id = ? and principal = ?`,
    ).run(subscriptionId, principal);
    return ok(id, {});
  }

  private async deliverRuntimeEvent(event: RuntimeEvent): Promise<void> {
    const now = new Date().toISOString();
    const rows = this.database.sqlite.prepare(
      `select id, principal, name, arguments_json, callback_url, signing_secret,
              status, created_at, updated_at, verified_at, expires_at
       from flyto2_mcp_event_subscriptions
       where name = ? and status = 'active' and expires_at > ?`,
    ).all(event.type, now) as McpEventSubscriptionRow[];

    for (const row of rows) {
      const subscription = subscriptionFromRow(row);
      if (!matchesSubscription(subscription, event)) continue;
      const outcome = await deliverWithRetry(subscription, event, this.webhookPost);
      this.appendDeliveryDiagnostic(subscription, event, outcome);
      if (outcome === "gone") {
        this.database.sqlite.prepare(
          "delete from flyto2_mcp_event_subscriptions where id = ?",
        ).run(subscription.id);
      }
    }
  }

  private appendDeliveryDiagnostic(
    subscription: McpEventSubscription,
    event: RuntimeEvent,
    outcome: "accepted" | "gone" | "rejected" | "failed",
  ): void {
    const type = outcome === "accepted"
      ? "mcp.event.delivered"
      : outcome === "failed"
        ? "mcp.event.delivery_failed"
        : outcome === "rejected"
          ? "mcp.event.delivery_rejected"
          : "mcp.event.subscription_gone";
    try {
      this.runtimeEvents.append({
        type,
        source: "mcp-events",
        workspace_id: event.workspace_id,
        correlation_id: event.correlation_id,
        summary: outcome === "accepted"
          ? "MCP event callback accepted the Runtime event."
          : `MCP event callback delivery ${outcome}.`,
        payload: {
          subscription_id: subscription.id,
          source_event_id: event.event_id,
          source_event_type: event.type,
          outcome,
        },
      });
    } catch {
      // Delivery diagnostics must never interfere with the delivery itself.
    }
  }
}

export function authenticatedMcpPrincipal(req: Request): string {
  const auth = req.auth as { clientId?: string } | undefined;
  if (auth?.clientId) return `client:${auth.clientId}`;
  const authorization = req.header("authorization") ?? "";
  return `bearer:${createHash("sha256").update(authorization).digest("hex")}`;
}

function eventDefinitions() {
  return EVENT_NAMES.map((name) => ({
    name,
    description: eventDescription(name),
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "Optional Runtime workspace to monitor.",
        },
        correlation_id: {
          type: "string",
          description: "Optional process or task correlation id to monitor.",
        },
      },
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        source: { type: "string" },
        workspace_id: { type: "string" },
        correlation_id: { type: "string" },
        summary: { type: "string" },
        payload: { type: "object" },
        evidence: { type: "array", items: { type: "object" } },
      },
      required: ["event_id", "source", "summary", "payload", "evidence"],
      additionalProperties: false,
    },
  }));
}

function eventDescription(name: SupportedEventName): string {
  switch (name) {
    case "process.completed":
      return "A durable Runtime process completed successfully.";
    case "process.failed":
      return "A durable Runtime process failed or timed out.";
    case "process.stalled":
      return "A durable Runtime process is still alive but has made no output progress.";
    case "task.needs_attention":
      return "A ChatGPT-owned durable task needs host attention after a process failure.";
  }
}

function parseSubscriptionParams(raw: unknown, requireSecret: boolean):
  | {
      name: string;
      arguments: Record<string, string>;
      delivery: { mode: "webhook"; url: string; secret?: string };
      ttlMs?: number | null;
    }
  | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Invalid subscription parameters." };
  const value = raw as Record<string, unknown>;
  if (typeof value.name !== "string" || !value.name.trim()) return { error: "Event name is required." };
  const args = normalizeArguments(value.arguments);
  if (!args) return { error: "Subscription arguments must contain only workspace_id/correlation_id strings." };
  const delivery = value.delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return { error: "Webhook delivery is required." };
  const d = delivery as Record<string, unknown>;
  if (d.mode !== "webhook" || typeof d.url !== "string") return { error: "Only webhook delivery is supported." };
  if (requireSecret && typeof d.secret !== "string") return { error: "Webhook signing secret is required." };
  if (value.ttlMs !== undefined && value.ttlMs !== null && (typeof value.ttlMs !== "number" || !Number.isFinite(value.ttlMs))) {
    return { error: "ttlMs must be a finite number or null." };
  }
  return {
    name: value.name,
    arguments: args,
    delivery: { mode: "webhook", url: d.url, secret: typeof d.secret === "string" ? d.secret : undefined },
    ttlMs: value.ttlMs as number | null | undefined,
  };
}

function normalizeArguments(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const allowed = new Set(["workspace_id", "correlation_id"]);
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!allowed.has(key) || typeof raw !== "string" || !raw.trim() || raw.length > 256) return undefined;
    result[key] = raw;
  }
  return result;
}

function validateSigningSecret(secret: string): string | undefined {
  if (!secret.startsWith("whsec_")) return "Signing secret must start with whsec_.";
  try {
    const decoded = Buffer.from(secret.slice(6), "base64");
    if (decoded.length < 24 || decoded.length > 64) return "Signing secret must decode to 24-64 bytes.";
  } catch {
    return "Signing secret is not valid base64.";
  }
  return undefined;
}

function normalizeTtlMs(value: number | null | undefined): number {
  if (value === undefined || value === null) return DEFAULT_SUBSCRIPTION_TTL_MS;
  return Math.max(60_000, Math.min(MAX_SUBSCRIPTION_TTL_MS, Math.floor(value)));
}

function canonicalJson(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

function deterministicSubscriptionId(
  principal: string,
  callbackUrl: string,
  name: string,
  canonicalArguments: string,
): string {
  return `sub_${createHash("sha256")
    .update(`${principal}\n${callbackUrl}\n${name}\n${canonicalArguments}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function subscriptionFromRow(row: McpEventSubscriptionRow): McpEventSubscription {
  return {
    id: row.id,
    principal: row.principal,
    name: row.name,
    arguments: JSON.parse(row.arguments_json) as Record<string, string>,
    callbackUrl: row.callback_url,
    signingSecret: row.signing_secret,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
  };
}

function matchesSubscription(subscription: McpEventSubscription, event: RuntimeEvent): boolean {
  const workspace = subscription.arguments.workspace_id;
  if (workspace && workspace !== event.workspace_id) return false;
  const correlation = subscription.arguments.correlation_id;
  if (correlation && correlation !== event.correlation_id) return false;
  return true;
}

async function verifyCallback(
  url: string,
  secret: string,
  subscriptionId: string,
  webhookPost: McpEventWebhookPost,
): Promise<void> {
  const challenge = randomBytes(24).toString("base64url");
  const body = JSON.stringify({ type: "verification", challenge });
  const messageId = `msg_verification_${randomUUID().replaceAll("-", "")}`;
  const response = await signedWebhookPost(url, secret, subscriptionId, messageId, body, webhookPost);
  if (response.status < 200 || response.status >= 300) throw new Error(`callback_status_${response.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error("challenge_invalid_json");
  }
  const returned = parsed && typeof parsed === "object"
    ? (parsed as { challenge?: unknown }).challenge
    : undefined;
  if (typeof returned !== "string" || !constantTimeEqual(returned, challenge)) {
    throw new Error("challenge_failed");
  }
}

async function deliverWithRetry(
  subscription: McpEventSubscription,
  event: RuntimeEvent,
  webhookPost: McpEventWebhookPost,
): Promise<"accepted" | "gone" | "rejected" | "failed"> {
  const body = JSON.stringify({
    eventId: event.event_id,
    name: subscription.name,
    timestamp: event.occurred_at,
    data: {
      event_id: event.event_id,
      source: event.source,
      ...(event.workspace_id ? { workspace_id: event.workspace_id } : {}),
      ...(event.correlation_id ? { correlation_id: event.correlation_id } : {}),
      summary: event.summary,
      payload: event.payload,
      evidence: event.evidence,
    },
    cursor: null,
  });
  if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BODY_BYTES) return "rejected";

  const delays = [0, 1_000, 4_000];
  for (let index = 0; index < delays.length; index += 1) {
    if (delays[index] > 0) await delay(delays[index]);
    try {
      const response = await signedWebhookPost(
        subscription.callbackUrl,
        subscription.signingSecret,
        subscription.id,
        event.event_id,
        body,
        webhookPost,
      );
      if (response.status >= 200 && response.status < 300) return "accepted";
      if (response.status === 410) return "gone";
      if (response.status === 413) return "rejected";
      if (response.status >= 400 && response.status < 500) return "rejected";
    } catch {
      // Retry bounded transient network failures.
    }
  }
  return "failed";
}

async function signedWebhookPost(
  url: string,
  secret: string,
  subscriptionId: string,
  messageId: string,
  body: string,
  webhookPost: McpEventWebhookPost,
): Promise<McpEventWebhookResponse> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = standardWebhookSignature(secret, messageId, timestamp, body);
  return webhookPost(url, body, {
    "Content-Type": "application/json",
    "webhook-id": messageId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signature,
    "X-MCP-Subscription-Id": subscriptionId,
  });
}

function standardWebhookSignature(secret: string, messageId: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.slice(6), "base64");
  const signature = createHmac("sha256", key)
    .update(`${messageId}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${signature}`;
}

async function secureWebhookPost(
  urlString: string,
  body: string,
  headers: Record<string, string>,
): Promise<McpEventWebhookResponse> {
  const url = new URL(urlString);
  validateCallbackUrl(urlString);
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("callback_private_address");
  }
  const target = addresses[0]!;

  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: target.address,
      family: target.family,
      port: url.port ? Number(url.port) : 443,
      method: "POST",
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      rejectUnauthorized: true,
      timeout: CALLBACK_TIMEOUT_MS,
      headers: {
        ...headers,
        Host: url.host,
        "Content-Length": Buffer.byteLength(body, "utf8"),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= 64 * 1024) chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.once("timeout", () => request.destroy(new Error("callback_timeout")));
    request.once("error", reject);
    request.end(body);
  });
}

function validateCallbackUrl(urlString: string): void {
  const url = new URL(urlString);
  if (url.protocol !== "https:") throw new Error("callback_https_required");
  if (url.username || url.password) throw new Error("callback_credentials_forbidden");
  if (url.hostname === "localhost" || isIP(url.hostname)) throw new Error("callback_public_host_required");
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return isPublicIpv4(address);
  if (isIP(address) === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b, c] = parts;
  if (a === undefined || b === undefined || c === undefined) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) === 4 && isPublicIpv4(mapped);
  }
  return true;
}

function callbackFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("timeout")) return "timeout";
  if (message.includes("challenge")) return "challenge_failed";
  if (message.includes("private") || message.includes("public_host")) return "unsafe_address";
  if (message.includes("https")) return "https_required";
  return "connection_failed";
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSupportedEventName(value: string): value is SupportedEventName {
  return (EVENT_NAMES as readonly string[]).includes(value);
}

function ok(id: string | number | null, result: unknown): JsonRpcResponseLike {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): JsonRpcResponseLike {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}
