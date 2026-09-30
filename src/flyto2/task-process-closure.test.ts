import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkspaceRegistry } from "../workspaces.js";
import { HostTaskStore, hostTaskExecutionState } from "./host-tasks.js";
import { ReactiveCommandRunner } from "./reactive-command.js";
import { RuntimeEventStore } from "./runtime-events.js";
import { attachTaskProcessClosure } from "./task-process-closure.js";

test("startup reconciliation turns stale active task into needs_attention after process failure", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-task-process-closure-"));
  const runtimeEvents = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, runtimeEvents);
  const hostTasks = new HostTaskStore(stateDir);
  t.after(async () => {
    runner.shutdown();
    runtimeEvents.close();
    hostTasks.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const workspaceId = "ws_task_process_closure";
  const task = hostTasks.create({
    workspaceId,
    repoRoot: stateDir,
    workspaceRoot: stateDir,
    prompt: "Fix the failing verification.",
  });
  const after = runtimeEvents.latestSequence();
  const receipt = runner.start({
    workspace_id: workspaceId,
    workspace_root: stateDir,
    cwd: stateDir,
    command: "node -e \"process.exit(3)\"",
  });
  const failed = await runtimeEvents.wait({
    after_sequence: after,
    workspace_id: workspaceId,
    type: "process.failed",
    correlation_id: receipt.job_id,
    timeout_ms: 3_000,
  });
  assert.equal(failed?.type, "process.failed");
  assert.equal(hostTaskExecutionState(hostTasks.get(task.id)!), "waiting_for_host");

  const detach = attachTaskProcessClosure({
    hostTasks,
    reactiveCommands: runner,
    runtimeEvents,
    workspaces: {} as WorkspaceRegistry,
  });
  t.after(detach);

  const reconciled = hostTasks.get(task.id);
  assert.equal(hostTaskExecutionState(reconciled!), "needs_attention");
  assert.match(reconciled?.attentionReason ?? "", /exit code 3/);
  const attention = runtimeEvents.list({ type: "task.needs_attention" });
  assert.equal(attention.length, 1);
  assert.equal(attention[0]?.correlation_id, task.id);
});
