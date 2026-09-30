import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostTaskStore } from "./host-tasks.js";
import { ReactiveCommandRunner } from "./reactive-command.js";
import { RuntimeEventStore } from "./runtime-events.js";
import { buildTaskDiagnosis } from "./task-diagnostics.js";

test("task diagnosis explains a failed long process with timeline and correlation", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-task-diagnosis-"));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  const tasks = new HostTaskStore(stateDir);
  t.after(async () => {
    runner.shutdown();
    events.close();
    tasks.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const workspaceId = "ws_diagnosis";
  const task = tasks.create({
    workspaceId,
    repoRoot: stateDir,
    workspaceRoot: stateDir,
    prompt: "Run verification and fix any failure.",
  });
  events.append({
    type: "task.started",
    source: "test",
    workspace_id: workspaceId,
    correlation_id: task.id,
    summary: "Task started.",
    payload: { task_id: task.id },
  });
  const cursor = events.latestSequence();
  const receipt = runner.start({
    workspace_id: workspaceId,
    workspace_root: stateDir,
    cwd: stateDir,
    event_type: "capability.test.exited",
    command: "node -e \"console.log('running tests'); process.exit(7)\"",
  });
  const failed = await events.wait({
    after_sequence: cursor,
    type: "process.failed",
    correlation_id: receipt.job_id,
    timeout_ms: 3_000,
  });
  assert.equal(failed?.type, "process.failed");
  tasks.markNeedsAttention(task.id, "Verification failed with exit code 7.");
  events.append({
    type: "task.needs_attention",
    source: "test",
    workspace_id: workspaceId,
    correlation_id: task.id,
    summary: "Task needs attention.",
    payload: { task_id: task.id, job_id: receipt.job_id, reason_code: "PROCESS_EXIT_NONZERO" },
  });

  const diagnosis = buildTaskDiagnosis(tasks.get(task.id)!, runner, events);
  assert.equal(diagnosis.state, "needs_attention");
  assert.equal(diagnosis.phase, "test");
  assert.equal(diagnosis.reason_code, "PROCESS_EXIT_NONZERO");
  assert.equal(diagnosis.confidence, "high");
  assert.equal(diagnosis.current_process?.exit_code, 7);
  assert.ok(diagnosis.current_process?.evidence_bytes);
  assert.ok(diagnosis.correlations.process_session_ids.some((id) => id.startsWith("proc_")));
  assert.ok(diagnosis.timeline.some((entry) => entry.type === "process.failed"));
  assert.ok(diagnosis.timeline.every((entry) => !JSON.stringify(entry).includes("running tests")));
});

test("task diagnosis distinguishes callback failure from process failure", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-task-callback-diagnosis-"));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  const tasks = new HostTaskStore(stateDir);
  t.after(async () => {
    runner.shutdown();
    events.close();
    tasks.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const workspaceId = "ws_callback_diagnosis";
  const task = tasks.create({
    workspaceId,
    repoRoot: stateDir,
    workspaceRoot: stateDir,
    prompt: "Build and continue after callback.",
  });
  const cursor = events.latestSequence();
  const receipt = runner.start({
    workspace_id: workspaceId,
    workspace_root: stateDir,
    cwd: stateDir,
    event_type: "capability.build.exited",
    command: "node -e \"process.exit(0)\"",
  });
  await events.wait({
    after_sequence: cursor,
    type: "process.completed",
    correlation_id: receipt.job_id,
    timeout_ms: 3_000,
  });
  events.append({
    type: "task.process.completed",
    source: "test",
    workspace_id: workspaceId,
    correlation_id: task.id,
    summary: "Task process completed.",
    payload: { task_id: task.id, job_id: receipt.job_id, reason_code: "PROCESS_COMPLETED" },
  });
  events.append({
    type: "mcp.event.delivery_failed",
    source: "mcp-events",
    workspace_id: workspaceId,
    correlation_id: task.id,
    summary: "Callback failed.",
    payload: {
      source_event_type: "process.completed",
      outcome: "failed",
      subscription_id: "sub_test",
    },
  });

  const diagnosis = buildTaskDiagnosis(task, runner, events);
  assert.equal(diagnosis.phase, "callback_wait");
  assert.equal(diagnosis.reason_code, "EVENT_CALLBACK_FAILED");
  assert.equal(diagnosis.suggested_action, "inspect_callback_delivery");
});
