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

test("live process lifecycle is correlated back to the owning durable task", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-task-process-timeline-"));
  const runtimeEvents = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, runtimeEvents);
  const hostTasks = new HostTaskStore(stateDir);
  const workspaceId = "ws_task_timeline";
  const workspaces = {
    getWorkspace: async () => ({ root: stateDir, sourceRoot: stateDir }),
  } as unknown as WorkspaceRegistry;
  const detach = attachTaskProcessClosure({
    hostTasks,
    reactiveCommands: runner,
    runtimeEvents,
    workspaces,
  });
  t.after(async () => {
    detach();
    runner.shutdown();
    runtimeEvents.close();
    hostTasks.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const task = hostTasks.create({
    workspaceId,
    repoRoot: stateDir,
    workspaceRoot: stateDir,
    prompt: "Run the test command.",
  });
  const cursor = runtimeEvents.latestSequence();
  const receipt = runner.start({
    workspace_id: workspaceId,
    workspace_root: stateDir,
    cwd: stateDir,
    event_type: "capability.test.exited",
    command: "node -e \"process.exit(2)\"",
  });
  const attention = await runtimeEvents.wait({
    after_sequence: cursor,
    type: "task.needs_attention",
    correlation_id: task.id,
    timeout_ms: 3_000,
  });
  assert.equal(attention?.payload.reason_code, "PROCESS_EXIT_NONZERO");

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (runtimeEvents.listRecent({ correlation_id: task.id, limit: 20 })
      .some((event) => event.type === "task.process.failed")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const timeline = runtimeEvents.listRecent({ correlation_id: task.id, limit: 20 });
  assert.ok(timeline.some((event) => event.type === "task.process.started"));
  const failed = timeline.find((event) => event.type === "task.process.failed");
  assert.equal(failed?.payload.job_id, receipt.job_id);
  assert.equal(failed?.payload.reason_code, "PROCESS_EXIT_NONZERO");
});

test("new host process activity resumes needs_attention without hiding a newer failure", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-task-process-resume-"));
  const runtimeEvents = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, runtimeEvents);
  const hostTasks = new HostTaskStore(stateDir);
  const workspaceId = "ws_task_resume";
  const workspaces = {
    getWorkspace: async () => ({ root: stateDir, sourceRoot: stateDir }),
  } as unknown as WorkspaceRegistry;
  const detach = attachTaskProcessClosure({
    hostTasks,
    reactiveCommands: runner,
    runtimeEvents,
    workspaces,
  });
  t.after(async () => {
    detach();
    runner.shutdown();
    runtimeEvents.close();
    hostTasks.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const task = hostTasks.create({
    workspaceId,
    repoRoot: stateDir,
    workspaceRoot: stateDir,
    prompt: "Fix the failing tests and continue.",
  });
  let cursor = runtimeEvents.latestSequence();
  const firstFailure = runner.start({
    workspace_id: workspaceId,
    workspace_root: stateDir,
    cwd: stateDir,
    event_type: "capability.test.exited",
    command: "node -e \"process.exit(1)\"",
  });
  const firstAttention = await runtimeEvents.wait({
    after_sequence: cursor,
    type: "task.needs_attention",
    correlation_id: task.id,
    timeout_ms: 3_000,
  });
  assert.equal(firstAttention?.payload.job_id, firstFailure.job_id);
  assert.equal(hostTaskExecutionState(hostTasks.get(task.id)!), "needs_attention");

  cursor = runtimeEvents.latestSequence();
  const resumedProcess = runner.start({
    workspace_id: workspaceId,
    workspace_root: stateDir,
    cwd: stateDir,
    event_type: "capability.test.exited",
    command: "node -e \"setTimeout(() => process.exit(0), 25)\"",
  });
  const resumed = await runtimeEvents.wait({
    after_sequence: cursor,
    type: "task.resumed",
    correlation_id: task.id,
    timeout_ms: 3_000,
  });
  assert.equal(resumed?.payload.job_id, resumedProcess.job_id);
  assert.equal(hostTaskExecutionState(hostTasks.get(task.id)!), "waiting_for_host");

  cursor = runtimeEvents.latestSequence();
  const secondFailure = runner.start({
    workspace_id: workspaceId,
    workspace_root: stateDir,
    cwd: stateDir,
    event_type: "capability.test.exited",
    command: "node -e \"process.exit(7)\"",
  });
  const secondAttention = await runtimeEvents.wait({
    after_sequence: cursor,
    type: "task.needs_attention",
    correlation_id: task.id,
    timeout_ms: 3_000,
  });
  assert.equal(secondAttention?.payload.job_id, secondFailure.job_id);
  assert.equal(secondAttention?.payload.exit_code, 7);
  assert.equal(hostTaskExecutionState(hostTasks.get(task.id)!), "needs_attention");
  assert.match(hostTasks.get(task.id)?.attentionReason ?? "", /exit code 7/);
});

test("process closure refuses to guess ownership when two active tasks share a workspace", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-task-process-ambiguous-"));
  const runtimeEvents = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, runtimeEvents);
  const hostTasks = new HostTaskStore(stateDir);
  const workspaceId = "ws_task_ambiguous";
  const workspaces = {
    getWorkspace: async () => ({ root: stateDir, sourceRoot: stateDir }),
  } as unknown as WorkspaceRegistry;
  const detach = attachTaskProcessClosure({
    hostTasks,
    reactiveCommands: runner,
    runtimeEvents,
    workspaces,
  });
  t.after(async () => {
    detach();
    runner.shutdown();
    runtimeEvents.close();
    hostTasks.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const first = hostTasks.create({
    workspaceId,
    repoRoot: stateDir,
    workspaceRoot: stateDir,
    prompt: "First task.",
  });
  const second = hostTasks.create({
    workspaceId,
    repoRoot: stateDir,
    workspaceRoot: stateDir,
    prompt: "Second task.",
  });
  const cursor = runtimeEvents.latestSequence();
  const receipt = runner.start({
    workspace_id: workspaceId,
    workspace_root: stateDir,
    cwd: stateDir,
    command: "node -e \"process.exit(9)\"",
  });
  await runtimeEvents.wait({
    after_sequence: cursor,
    type: "process.failed",
    correlation_id: receipt.job_id,
    timeout_ms: 3_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hostTaskExecutionState(hostTasks.get(first.id)!), "waiting_for_host");
  assert.equal(hostTaskExecutionState(hostTasks.get(second.id)!), "waiting_for_host");
  assert.equal(runtimeEvents.listRecent({ correlation_id: first.id, limit: 20 }).some((event) => event.type.startsWith("task.process.")), false);
  assert.equal(runtimeEvents.listRecent({ correlation_id: second.id, limit: 20 }).some((event) => event.type.startsWith("task.process.")), false);
});
