import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import { resolveShellCommand, terminateProcessTree } from "../process-platform.js";
import type { Flyto2EvidenceRef } from "./protocol.js";
import { RuntimeEventStore } from "./runtime-events.js";

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MAX_EVIDENCE_READ_CHARACTERS = 64 * 1024;

export interface ReactiveCommandInput {
  workspace_id: string;
  workspace_root: string;
  command: string;
  cwd: string;
  event_type?: string;
}

export interface ReactiveJobReceipt {
  job_id: string;
  status: "running";
  event_type: string;
  evidence_ref: string;
  command_digest: string;
  started_at: string;
}

export interface ReactiveJobRecord {
  job_id: string;
  workspace_id: string;
  command_digest: string;
  event_type: string;
  status: "running" | "completed" | "failed" | "orphaned";
  evidence_ref: string;
  started_at: string;
  completed_at?: string;
  exit_code?: number;
  signal?: string;
}

interface ReactiveJobRow {
  id: string;
  workspace_id: string;
  command_digest: string;
  event_type: string;
  status: ReactiveJobRecord["status"];
  evidence_path: string;
  started_at: string;
  completed_at: string | null;
  exit_code: number | null;
  signal: string | null;
}

interface ActiveReactiveJob {
  child: ChildProcess;
  evidenceFd: number;
  evidenceBytes: number;
  truncated: boolean;
  finished: boolean;
}

export class ReactiveCommandRunner {
  private readonly database: DatabaseHandle;
  private readonly evidenceDir: string;
  private readonly active = new Map<string, ActiveReactiveJob>();
  private closed = false;

  constructor(
    private readonly stateDir: string,
    private readonly events: RuntimeEventStore,
  ) {
    this.database = openDatabase(stateDir);
    this.evidenceDir = join(stateDir, "evidence");
    mkdirSync(this.evidenceDir, { recursive: true, mode: 0o700 });
    this.reconcileInterruptedJobs();
  }

  start(input: ReactiveCommandInput): ReactiveJobReceipt {
    if (this.closed) throw new Error("Reactive command runner is closed.");
    const command = input.command.trim();
    if (!command) throw new Error("Reactive command cannot be empty.");

    const jobId = `job_${randomUUID().replaceAll("-", "")}`;
    const commandDigest = createHash("sha256").update(command).digest("hex");
    const eventType = normalizeEventType(input.event_type);
    const startedAt = new Date().toISOString();
    const evidencePath = join(this.evidenceDir, `${jobId}.log`);
    const evidenceRef = evidenceRefForJob(jobId);
    const evidenceFd = openSync(evidencePath, "wx", 0o600);

    this.database.sqlite
      .prepare(
        `insert into flyto2_reactive_jobs (
          id, workspace_id, command_digest, event_type, status,
          evidence_path, started_at
        ) values (?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        jobId,
        input.workspace_id,
        commandDigest,
        eventType,
        evidencePath,
        startedAt,
      );

    const shell = resolveShellCommand(command);
    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd: input.cwd,
        env: reactiveEnvironment(input.workspace_id, input.workspace_root),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        shell: shell.executable,
      });
    } catch (error) {
      closeSync(evidenceFd);
      this.failBeforeStart(jobId, input.workspace_id, eventType, commandDigest, error);
      throw error;
    }

    const active: ActiveReactiveJob = {
      child,
      evidenceFd,
      evidenceBytes: 0,
      truncated: false,
      finished: false,
    };
    this.active.set(jobId, active);

    const append = (data: Buffer) => this.appendEvidence(active, data);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      this.appendEvidence(active, Buffer.from(`${error.message}\n`, "utf8"));
    });
    child.on("close", (code, signal) => {
      void this.finish(
        jobId,
        input.workspace_id,
        eventType,
        commandDigest,
        startedAt,
        code ?? undefined,
        signal ?? undefined,
      );
    });

    this.events.append({
      type: "process.started",
      source: "reactive-runner",
      workspace_id: input.workspace_id,
      correlation_id: jobId,
      summary: "Reactive command started.",
      payload: {
        job_id: jobId,
        event_type: eventType,
        command_digest: commandDigest,
      },
      evidence: [{ kind: "process.log", ref: evidenceRef }],
    });

    return {
      job_id: jobId,
      status: "running",
      event_type: eventType,
      evidence_ref: evidenceRef,
      command_digest: commandDigest,
      started_at: startedAt,
    };
  }

  get(jobId: string): ReactiveJobRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        `select id, workspace_id, command_digest, event_type, status,
                evidence_path, started_at, completed_at, exit_code, signal
         from flyto2_reactive_jobs where id = ?`,
      )
      .get(jobId) as ReactiveJobRow | undefined;
    return row ? reactiveJobFromRow(row) : undefined;
  }

  readEvidence(
    reference: string,
    maxCharacters = MAX_EVIDENCE_READ_CHARACTERS,
  ): { job: ReactiveJobRecord; text: string; truncated: boolean } {
    const jobId = jobIdFromEvidenceRef(reference);
    const row = this.database.sqlite
      .prepare(
        `select id, workspace_id, command_digest, event_type, status,
                evidence_path, started_at, completed_at, exit_code, signal
         from flyto2_reactive_jobs where id = ?`,
      )
      .get(jobId) as ReactiveJobRow | undefined;
    if (!row) throw new Error(`Unknown reactive job evidence: ${reference}`);

    if (!Number.isInteger(maxCharacters) || maxCharacters < 256 || maxCharacters > 256_000) {
      throw new Error("max_characters must be an integer between 256 and 256000.");
    }

    const text = existsSync(row.evidence_path)
      ? readFileSync(row.evidence_path, "utf8")
      : "";
    if (text.length <= maxCharacters) {
      return { job: reactiveJobFromRow(row), text, truncated: false };
    }

    const half = Math.floor((maxCharacters - 64) / 2);
    return {
      job: reactiveJobFromRow(row),
      text:
        text.slice(0, half)
        + "\n... evidence truncated; request a larger bound if needed ...\n"
        + text.slice(-half),
      truncated: true,
    };
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const active of this.active.values()) {
      if (!active.finished) {
        try {
          terminateProcessTree(
            active.child,
            "SIGTERM",
            process.platform !== "win32",
          );
        } catch {
          // The next startup will reconcile any still-running database row.
        }
      }
      try {
        closeSync(active.evidenceFd);
      } catch {
        // Already closed by completion.
      }
    }
    this.active.clear();
    this.database.close();
  }

  private async finish(
    jobId: string,
    workspaceId: string,
    eventType: string,
    commandDigest: string,
    startedAt: string,
    exitCode?: number,
    signal?: NodeJS.Signals,
  ): Promise<void> {
    const active = this.active.get(jobId);
    if (!active || active.finished || this.closed) return;
    active.finished = true;
    closeSync(active.evidenceFd);
    this.active.delete(jobId);

    const completedAt = new Date().toISOString();
    const success = exitCode === 0 && signal === undefined;
    this.database.sqlite
      .prepare(
        `update flyto2_reactive_jobs
         set status = ?, completed_at = ?, exit_code = ?, signal = ?
         where id = ?`,
      )
      .run(
        success ? "completed" : "failed",
        completedAt,
        exitCode ?? null,
        signal ?? null,
        jobId,
      );

    const evidence = evidenceMetadata(this.evidenceDir, jobId);
    this.events.append({
      type: eventType,
      source: "reactive-runner",
      workspace_id: workspaceId,
      correlation_id: jobId,
      summary: success
        ? "Reactive command completed successfully."
        : "Reactive command exited unsuccessfully.",
      payload: {
        job_id: jobId,
        success,
        exit_code: exitCode ?? null,
        signal: signal ?? null,
        duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        command_digest: commandDigest,
        log_truncated: active.truncated,
      },
      evidence: [evidence],
    });
  }

  private appendEvidence(active: ActiveReactiveJob, data: Buffer): void {
    if (active.finished || this.closed || data.length === 0) return;
    const remaining = MAX_EVIDENCE_BYTES - active.evidenceBytes;
    if (remaining <= 0) {
      active.truncated = true;
      return;
    }
    const chunk = data.subarray(0, remaining);
    writeSync(active.evidenceFd, chunk);
    active.evidenceBytes += chunk.length;
    if (chunk.length < data.length) active.truncated = true;
  }

  private failBeforeStart(
    jobId: string,
    workspaceId: string,
    eventType: string,
    commandDigest: string,
    error: unknown,
  ): void {
    const completedAt = new Date().toISOString();
    this.database.sqlite
      .prepare(
        `update flyto2_reactive_jobs
         set status = 'failed', completed_at = ?
         where id = ?`,
      )
      .run(completedAt, jobId);
    this.events.append({
      type: eventType,
      source: "reactive-runner",
      workspace_id: workspaceId,
      correlation_id: jobId,
      summary: "Reactive command failed to start.",
      payload: {
        job_id: jobId,
        success: false,
        command_digest: commandDigest,
        error: error instanceof Error ? error.message : String(error),
      },
      evidence: [{ kind: "process.log", ref: evidenceRefForJob(jobId) }],
    });
  }

  private reconcileInterruptedJobs(): void {
    const rows = this.database.sqlite
      .prepare(
        `select id, workspace_id, command_digest, event_type, status,
                evidence_path, started_at, completed_at, exit_code, signal
         from flyto2_reactive_jobs where status = 'running'`,
      )
      .all() as ReactiveJobRow[];
    if (rows.length === 0) return;

    const completedAt = new Date().toISOString();
    const update = this.database.sqlite.prepare(
      `update flyto2_reactive_jobs
       set status = 'orphaned', completed_at = ?
       where id = ? and status = 'running'`,
    );
    const transaction = this.database.sqlite.transaction(() => {
      for (const row of rows) update.run(completedAt, row.id);
    });
    transaction.immediate();

    for (const row of rows) {
      this.events.append({
        event_id: `evt_orphaned_${row.id}`,
        type: "process.orphaned",
        source: "reactive-runner",
        workspace_id: row.workspace_id,
        correlation_id: row.id,
        summary: "Reactive command was running when the Runtime restarted; outcome is uncertain.",
        payload: {
          job_id: row.id,
          command_digest: row.command_digest,
          retry_safe: false,
        },
        evidence: [{ kind: "process.log", ref: evidenceRefForJob(row.id) }],
      });
    }
  }
}

function reactiveEnvironment(
  workspaceId: string,
  workspaceRoot: string,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    DEVSPACE_WORKSPACE_ID: workspaceId,
    DEVSPACE_WORKSPACE_ROOT: workspaceRoot,
    FLYTO2_RUNTIME: "1",
  };
}

function normalizeEventType(value: string | undefined): string {
  const eventType = value?.trim() || "process.exited";
  if (eventType.length > 128) throw new Error("event_type must be at most 128 characters.");
  return eventType;
}

function evidenceRefForJob(jobId: string): string {
  return `flyto2://evidence/${jobId}`;
}

function jobIdFromEvidenceRef(reference: string): string {
  const prefix = "flyto2://evidence/";
  if (reference.startsWith(prefix)) return reference.slice(prefix.length);
  if (reference.startsWith("job_")) return reference;
  throw new Error("Evidence reference must be a Flyto2 evidence URI or reactive job id.");
}

function evidenceMetadata(
  evidenceDir: string,
  jobId: string,
): Flyto2EvidenceRef {
  const path = join(evidenceDir, `${jobId}.log`);
  const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  return {
    kind: "process.log",
    ref: evidenceRefForJob(jobId),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

function reactiveJobFromRow(row: ReactiveJobRow): ReactiveJobRecord {
  return {
    job_id: row.id,
    workspace_id: row.workspace_id,
    command_digest: row.command_digest,
    event_type: row.event_type,
    status: row.status,
    evidence_ref: evidenceRefForJob(row.id),
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    exit_code: row.exit_code ?? undefined,
    signal: row.signal ?? undefined,
  };
}
