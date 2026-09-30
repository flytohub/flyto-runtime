import type { HostTaskRecord, HostTaskStore } from "./host-tasks.js";
import type { ReactiveCommandRunner, ReactiveJobRecord } from "./reactive-command.js";
import type { RuntimeEventStore } from "./runtime-events.js";
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

  return reactiveCommands.onTerminal((job) => {
    if (!requiresAttention(job)) return;
    void resolveOwningTask(hostTasks, workspaces, job).then((task) => {
      if (!task) return;
      markTaskAttention(hostTasks, runtimeEvents, task, job);
    }).catch(() => {
      // Recovery remains available through open_workspace even if advisory
      // task-state reconciliation cannot resolve a workspace after termination.
    });
  });
}

function reconcileExistingAttention(
  hostTasks: HostTaskStore,
  reactiveCommands: ReactiveCommandRunner,
  runtimeEvents: RuntimeEventStore,
): void {
  const active = hostTasks.listActive();
  for (const task of active) {
    if (task.attentionReason) continue;
    let latest = reactiveCommands.latestForWorkspace(task.workspaceId);
    if (!latest) {
      const siblings = hostTasks.listActiveByRepoRoot(task.repoRoot);
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
  const direct = hostTasks.findLatestActiveByWorkspaceId(job.workspace_id);
  if (direct) return direct;

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
      reason,
    },
    evidence: [{ kind: "process.log", ref: job.evidence_ref }],
  });
}
