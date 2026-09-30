import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import { resolveShellCommand, terminateProcessTree } from "../process-platform.js";
import type { Flyto2EvidenceRef } from "./protocol.js";
import { RuntimeEventStore } from "./runtime-events.js";

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MAX_EVIDENCE_READ_CHARACTERS = 64 * 1024;
const MAX_IDLE_STALL_STRIKES = 3;
const MAX_IDLE_BACKOFF_MULTIPLIER = 4;

export interface ReactiveCommandInput {
  workspace_id: string;
  workspace_root: string;
  command: string;
  cwd: string;
  event_type?: string;
  timeout_seconds?: number;
  timeout_mode?: "deadline" | "idle";
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
  elapsed_ms: number;
  evidence_bytes: number;
  last_activity_at: string;
  idle_ms: number;
  suspected_stall: boolean;
}

export interface ReactiveRunnerHealth {
  active_processes: number;
  running: number;
  completed: number;
  failed: number;
  orphaned: number;
}

export function reactiveJobSessionId(jobId: string): string {
  const match = /^job_([a-f0-9]{32})$/.exec(jobId);
  if (!match) throw new Error("Runtime returned an invalid process session identifier.");
  return `proc_${match[1]}`;
}

export function reactiveJobIdFromSessionId(sessionId: string): string {
  const opaque = /^proc_([a-f0-9]{32})$/.exec(sessionId);
  if (opaque) return `job_${opaque[1]}`;

  // Accept sessions issued by older Codex-mode Runtime builds across an upgrade,
  // but never emit the internal job identifier on the model-facing surface.
  if (/^job_[a-f0-9]{32}$/.test(sessionId)) return sessionId;
  throw new Error("Unknown process session identifier.");
}

export type ReactiveJobTerminalListener = (job: ReactiveJobRecord) => void;

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
  jobId: string;
  workspaceId: string;
  eventType: string;
  child: ChildProcess;
  evidenceFd: number;
  evidenceBytes: number;
  truncated: boolean;
  finished: boolean;
  timedOut: boolean;
  idleStallStrikes: number;
  lastActivityAt: number;
  timeoutSeconds?: number;
  timeoutMode?: "deadline" | "idle";
  timeoutTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
}

export class ReactiveCommandRunner {
  private readonly database: DatabaseHandle;
  private readonly evidenceDir: string;
  private readonly active = new Map<string, ActiveReactiveJob>();
  private readonly terminalListeners = new Set<ReactiveJobTerminalListener>();
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
      jobId,
      workspaceId: input.workspace_id,
      eventType,
      child,
      evidenceFd,
      evidenceBytes: 0,
      truncated: false,
      finished: false,
      timedOut: false,
      idleStallStrikes: 0,
      lastActivityAt: Date.now(),
    };
    this.active.set(jobId, active);

    const timeoutSeconds = normalizeTimeoutSeconds(input.timeout_seconds);
    if (timeoutSeconds !== undefined) {
      active.timeoutSeconds = timeoutSeconds;
      active.timeoutMode = input.timeout_mode ?? "idle";
      this.armTimeout(active);
    }

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
    return row ? reactiveJobFromRow(row, this.active.get(row.id)) : undefined;
  }

  listRunningForRepository(repoRoot: string, limit = 8): ReactiveJobRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) {
      throw new Error("Reactive job recovery limit must be an integer between 1 and 32.");
    }
    const rows = this.database.sqlite
      .prepare(
        `select jobs.id, jobs.workspace_id, jobs.command_digest, jobs.event_type, jobs.status,
                jobs.evidence_path, jobs.started_at, jobs.completed_at, jobs.exit_code, jobs.signal
         from flyto2_reactive_jobs as jobs
         join workspace_sessions as workspaces on workspaces.id = jobs.workspace_id
         where jobs.status = 'running'
           and coalesce(nullif(workspaces.source_root, ''), workspaces.root) = ?
         order by jobs.started_at desc, jobs.rowid desc
         limit ?`,
      )
      .all(repoRoot, limit) as ReactiveJobRow[];
    return rows.map((row) => reactiveJobFromRow(row, this.active.get(row.id)));
  }

  latestForRepository(repoRoot: string): ReactiveJobRecord | undefined {
    const row = this.database.sqlite.prepare(
      `select jobs.id, jobs.workspace_id, jobs.command_digest, jobs.event_type, jobs.status,
              jobs.evidence_path, jobs.started_at, jobs.completed_at, jobs.exit_code, jobs.signal
       from flyto2_reactive_jobs as jobs
       join workspace_sessions as workspaces on workspaces.id = jobs.workspace_id
       where coalesce(nullif(workspaces.source_root, ''), workspaces.root) = ?
       order by jobs.started_at desc
       limit 1`,
    ).get(repoRoot) as ReactiveJobRow | undefined;
    return row ? reactiveJobFromRow(row, this.active.get(row.id)) : undefined;
  }

  latestForWorkspace(workspaceId: string): ReactiveJobRecord | undefined {
    const row = this.database.sqlite.prepare(
      `select id, workspace_id, command_digest, event_type, status,
              evidence_path, started_at, completed_at, exit_code, signal
       from flyto2_reactive_jobs
       where workspace_id = ?
       order by started_at desc
       limit 1`,
    ).get(workspaceId) as ReactiveJobRow | undefined;
    return row ? reactiveJobFromRow(row, this.active.get(row.id)) : undefined;
  }

  onTerminal(listener: ReactiveJobTerminalListener): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  signal(
    jobId: string,
    workspaceId: string,
    signal: NodeJS.Signals = "SIGTERM",
  ): ReactiveJobRecord {
    const job = this.get(jobId);
    if (!job || job.workspace_id !== workspaceId) {
      throw new Error(`Unknown reactive job ${jobId} for workspace ${workspaceId}.`);
    }
    if (job.status !== "running") return job;

    const active = this.active.get(jobId);
    if (!active) {
      throw new Error(
        `Reactive job ${jobId} is marked running but has no active process.`,
      );
    }
    terminateProcessTree(
      active.child,
      signal,
      process.platform !== "win32",
    );
    return job;
  }

  discardTerminal(jobId: string): boolean {
    if (this.active.has(jobId)) return false;
    const row = this.database.sqlite
      .prepare(
        `select id, workspace_id, command_digest, event_type, status,
                evidence_path, started_at, completed_at, exit_code, signal
         from flyto2_reactive_jobs where id = ?`,
      )
      .get(jobId) as ReactiveJobRow | undefined;
    if (!row || row.status === "running") return false;

    this.database.sqlite
      .prepare("delete from flyto2_reactive_jobs where id = ? and status != 'running'")
      .run(jobId);
    this.events.removeByCorrelationId(jobId);
    if (existsSync(row.evidence_path)) {
      try {
        unlinkSync(row.evidence_path);
      } catch {
        // A leftover 0600 evidence file is safer than failing a completed tool response.
      }
    }
    return true;
  }

  health(): ReactiveRunnerHealth {
    const rows = this.database.sqlite
      .prepare(
        `select status, count(*) as count
         from flyto2_reactive_jobs
         group by status`,
      )
      .all() as Array<{ status: ReactiveJobRecord["status"]; count: number }>;
    const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
    return {
      active_processes: this.active.size,
      running: counts.get("running") ?? 0,
      completed: counts.get("completed") ?? 0,
      failed: counts.get("failed") ?? 0,
      orphaned: counts.get("orphaned") ?? 0,
    };
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
      return { job: reactiveJobFromRow(row, this.active.get(row.id)), text, truncated: false };
    }

    const half = Math.floor((maxCharacters - 64) / 2);
    return {
      job: reactiveJobFromRow(row, this.active.get(row.id)),
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
      if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
      if (active.killTimer) clearTimeout(active.killTimer);
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
    this.terminalListeners.clear();
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
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    if (active.killTimer) clearTimeout(active.killTimer);
    closeSync(active.evidenceFd);
    this.active.delete(jobId);

    const completedAt = new Date().toISOString();
    const success = !active.timedOut && exitCode === 0 && signal === undefined;
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
        timed_out: active.timedOut,
      },
      evidence: [evidence],
    });
    const terminalEventType = success ? "process.completed" : "process.failed";
    if (eventType !== terminalEventType) {
      this.events.append({
        type: terminalEventType,
        source: "reactive-runner",
        workspace_id: workspaceId,
        correlation_id: jobId,
        summary: success
          ? "Reactive command completed successfully."
          : "Reactive command exited unsuccessfully.",
        payload: {
          job_id: jobId,
          event_type: eventType,
          success,
          exit_code: exitCode ?? null,
          signal: signal ?? null,
          duration_ms: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
          command_digest: commandDigest,
          log_truncated: active.truncated,
          timed_out: active.timedOut,
        },
        evidence: [evidence],
      });
    }
    this.notifyTerminal(jobId);
  }

  private appendEvidence(active: ActiveReactiveJob, data: Buffer): void {
    if (active.finished || this.closed || data.length === 0) return;
    active.lastActivityAt = Date.now();
    if (active.timeoutMode === "idle" && !active.timedOut) {
      active.idleStallStrikes = 0;
      this.armTimeout(active);
    }
    this.writeEvidence(active, data);
  }

  private writeEvidence(active: ActiveReactiveJob, data: Buffer): void {
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

  private armTimeout(active: ActiveReactiveJob): void {
    const timeoutSeconds = active.timeoutSeconds;
    if (timeoutSeconds === undefined || active.finished || this.closed) return;
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    const idleMultiplier = active.timeoutMode === "idle"
      ? Math.min(
          MAX_IDLE_BACKOFF_MULTIPLIER,
          Math.max(1, 2 ** active.idleStallStrikes),
        )
      : 1;
    const timeoutMs = timeoutSeconds * idleMultiplier * 1_000;
    active.timeoutTimer = setTimeout(() => {
      if (active.finished || this.closed) return;
      if (active.timeoutMode === "idle" && active.child.exitCode === null) {
        active.idleStallStrikes += 1;
        if (active.idleStallStrikes === 1) {
          this.events.append({
            type: "process.stalled",
            source: "reactive-runner",
            workspace_id: active.workspaceId,
            correlation_id: active.jobId,
            summary: "Reactive command is alive but has made no output progress.",
            payload: {
              job_id: active.jobId,
              event_type: active.eventType,
              observation: active.idleStallStrikes,
              idle_window_seconds: timeoutSeconds * idleMultiplier,
            },
            evidence: [{ kind: "process.log", ref: evidenceRefForJob(active.jobId) }],
          });
        }
        if (active.idleStallStrikes < MAX_IDLE_STALL_STRIKES) {
          const nextMultiplier = Math.min(
            MAX_IDLE_BACKOFF_MULTIPLIER,
            2 ** active.idleStallStrikes,
          );
          this.writeEvidence(
            active,
            Buffer.from(
              `Flyto2 Runtime: no command output progress for ${timeoutSeconds * idleMultiplier} seconds, but the process is still alive; extending the stall watchdog (observation ${active.idleStallStrikes}/${MAX_IDLE_STALL_STRIKES}, next window ${timeoutSeconds * nextMultiplier} seconds).\n`,
              "utf8",
            ),
          );
          this.armTimeout(active);
          return;
        }
      }
      active.timedOut = true;
      const message = active.timeoutMode === "idle"
        ? `Flyto2 Runtime: command remained alive without output progress across ${MAX_IDLE_STALL_STRIKES} adaptive watchdog observations; terminating the stalled process.\n`
        : `Flyto2 Runtime: command timed out after ${timeoutSeconds} seconds.\n`;
      this.writeEvidence(active, Buffer.from(message, "utf8"));
      try {
        terminateProcessTree(
          active.child,
          "SIGTERM",
          process.platform !== "win32",
        );
      } catch {
        // The close/error handlers below will reconcile the final state.
      }
      active.killTimer = setTimeout(() => {
        if (active.finished || this.closed) return;
        try {
          terminateProcessTree(
            active.child,
            "SIGKILL",
            process.platform !== "win32",
          );
        } catch {
          // The next Runtime startup will reconcile a still-running row.
        }
      }, 1_000);
      active.killTimer.unref();
    }, timeoutMs);
    active.timeoutTimer.unref();
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
    this.notifyTerminal(jobId);
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

  private notifyTerminal(jobId: string): void {
    const job = this.get(jobId);
    if (!job || job.status === "running") return;
    for (const listener of this.terminalListeners) {
      try {
        listener(job);
      } catch {
        // Listener failures must never corrupt the reactive runner's durable state.
      }
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

function normalizeTimeoutSeconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0 || value > 3_600) {
    throw new Error("timeout_seconds must be greater than 0 and at most 3600.");
  }
  return value;
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

function reactiveJobFromRow(
  row: ReactiveJobRow,
  active?: ActiveReactiveJob,
): ReactiveJobRecord {
  const startedMs = Date.parse(row.started_at);
  const completedMs = row.completed_at ? Date.parse(row.completed_at) : undefined;
  const now = Date.now();
  const evidenceStat = safeEvidenceStat(row.evidence_path);
  const lastActivityMs = active?.lastActivityAt ?? evidenceStat?.mtimeMs ?? startedMs;
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
    elapsed_ms: Math.max(0, (completedMs ?? now) - startedMs),
    evidence_bytes: active?.evidenceBytes ?? evidenceStat?.size ?? 0,
    last_activity_at: new Date(lastActivityMs).toISOString(),
    idle_ms: row.status === "running" ? Math.max(0, now - lastActivityMs) : 0,
    suspected_stall: row.status === "running" && (active?.idleStallStrikes ?? 0) > 0,
  };
}

function safeEvidenceStat(path: string): { size: number; mtimeMs: number } | undefined {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}
