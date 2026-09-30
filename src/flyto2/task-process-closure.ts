import type { HostTaskRecord, HostTaskStore } from "./host-tasks.js";
import type { ReactiveCommandRunner, ReactiveJobRecord } from "./reactive-command.js";
import type { RuntimeEventStore } from "./runtime-events.js";
import type { RuntimeEvent } from "./runtime-events.js";
import type { WorkspaceRegistry } from "../workspaces.js";

/**
 * Keeps ChatGPT-owned durable task state aligned with terminal Runtime processes.
 * It never completes a task automatically; failed/orphaned processes only move
 * the owning task into needs_attention so the host can safely resume it.
 */
export function attachTaskProcessClosure(options: {
  hostTasks: HostTaskStore;
  reactiveCommands: ReactiveCommandRunner;
  runtimeEvents: RuntimeEventStore;
  workspaces: WorkspaceRegistry;
}): () => void {
  const { hostTasks, reactiveCommands, runtimeEvents, workspaces } = options;

  reconcileExistingAttention(hostTasks, reactiveCommands, runtimeEvents);

  const detachTimeline = runtimeEvents.onEvent((event) => {
    if (!isProcessLifecycleEvent(event.type)) return;
    const jobId = processJobId(event);
    if (!jobId) return;
    const job = reactiveCommands.get(jobId);
    if (!job) return;
    void resolveOwningTask(hostTasks, workspaces, job).then((task) => {
      if (!task) return;
      appendTaskProcessEvent(runtimeEvents, task, job, event);
    }).catch(() => {
      // Timeline projection is advisory and must never affect process state.
    });
  });

  const detachTerminal = reactiveCommands.onTerminal((job) => {
    if (!requiresAttention(job)) return;
    void resolveOwningTask(hostTasks, workspaces, job).then((task) => {
      if (!task) return;
      markTaskAttention(hostTasks, runtimeEvents, task, job);
    }).catch(() => {
      // Recovery remains available through open_workspace even if advisory
      // task-state reconciliation cannot resolve a workspace after termination.
    });
  });
  return () => {
    detachTimeline();
    detachTerminal();
  };
}

function reconcileExistingAttention(
  hostTasks: HostTaskStore,
  reactiveCommands: ReactiveCommandRunner,
  runtimeEvents: RuntimeEventStore,
): void {
  const active = hostTasks.listActive();
  for (const task of active) {
    if (task.attentionReason) continue;
    const workspaceSiblings = active.filter((candidate) => candidate.workspaceId === task.workspaceId);
    let latest = workspaceSiblings.length === 1
      ? reactiveCommands.latestForWorkspace(task.workspaceId)
      : undefined;
    if (!latest) {
      const siblings = active.filter((candidate) => candidate.repoRoot === task.repoRoot);
      if (siblings.length === 1) latest = reactiveCommands.latestForRepository(task.repoRoot);
    }
    if (!latest || !requiresAttention(latest) || !latest.completed_at) continue;
    if (Date.parse(latest.completed_at) < Date.parse(task.updatedAt)) continue;
    markTaskAttention(hostTasks, runtimeEvents, task, latest);
  }
}

async function resolveOwningTask(
  hostTasks: HostTaskStore,
  workspaces: WorkspaceRegistry,
  job: ReactiveJobRecord,
): Promise<HostTaskRecord | undefined> {
  const direct = hostTasks.listActiveByWorkspaceId(job.workspace_id);
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return undefined;

  const workspace = await workspaces.getWorkspace(job.workspace_id);
  const repoRoot = workspace.sourceRoot ?? workspace.root;
  const candidates = hostTasks.listActiveByRepoRoot(repoRoot);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function requiresAttention(job: ReactiveJobRecord): boolean {
  return job.status === "failed" || job.status === "orphaned";
}

function markTaskAttention(
  hostTasks: HostTaskStore,
  runtimeEvents: RuntimeEventStore,
  task: HostTaskRecord,
  job: ReactiveJobRecord,
): void {
  const reason = job.status === "orphaned"
    ? "The Runtime restarted before the process reached a known terminal result."
    : `Process ${job.event_type} failed${job.exit_code === undefined ? "" : ` with exit code ${job.exit_code}`}.`;
  const updated = hostTasks.markNeedsAttention(task.id, reason);
  if (!updated) return;
  runtimeEvents.append({
    type: "task.needs_attention",
    source: "task-process-closure",
    workspace_id: job.workspace_id,
    correlation_id: task.id,
    summary: "Durable task needs host attention after a process failure.",
    payload: {
      task_id: task.id,
      job_id: job.job_id,
      process_status: job.status,
      event_type: job.event_type,
      exit_code: job.exit_code,
      signal: job.signal,
      reason_code: diagnosticReasonCode(job),
      reason,
    },
    evidence: [{ kind: "process.log", ref: job.evidence_ref }],
  });
}

function appendTaskProcessEvent(
  runtimeEvents: RuntimeEventStore,
  task: HostTaskRecord,
  job: ReactiveJobRecord,
  event: RuntimeEvent,
): void {
  const suffix = event.type.slice("process.".length);
  runtimeEvents.append({
    type: `task.process.${suffix}`,
    source: "task-process-closure",
    workspace_id: job.workspace_id,
    correlation_id: task.id,
    summary: `Task process ${suffix}.`,
    payload: {
      task_id: task.id,
      job_id: job.job_id,
      event_type: job.event_type,
      process_status: job.status,
      elapsed_ms: job.elapsed_ms,
      evidence_bytes: job.evidence_bytes,
      last_activity_at: job.last_activity_at,
      idle_ms: job.idle_ms,
      suspected_stall: job.suspected_stall,
      exit_code: job.exit_code,
      signal: job.signal,
      reason_code: event.type === "process.stalled"
        ? "PROCESS_STALLED"
        : diagnosticReasonCode(job),
    },
    evidence: event.evidence,
    occurred_at: event.occurred_at,
  });
}

function diagnosticReasonCode(job: ReactiveJobRecord): string {
  if (job.status === "orphaned") return "PROCESS_ORPHANED";
  if (job.signal) return "PROCESS_SIGNALLED";
  if (job.status === "failed" && job.exit_code !== undefined && job.exit_code !== 0) {
    return "PROCESS_EXIT_NONZERO";
  }
  if (job.suspected_stall) return "PROCESS_STALLED";
  if (job.status === "completed") return "PROCESS_COMPLETED";
  return "PROCESS_RUNNING";
}

function isProcessLifecycleEvent(type: string): boolean {
  return type === "process.started"
    || type === "process.stalled"
    || type === "process.completed"
    || type === "process.failed"
    || type === "process.orphaned";
}

function processJobId(event: RuntimeEvent): string | undefined {
  const fromPayload = event.payload.job_id;
  if (typeof fromPayload === "string" && fromPayload) return fromPayload;
  return typeof event.correlation_id === "string" ? event.correlation_id : undefined;
}
