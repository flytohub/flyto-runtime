import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostTaskStore } from "./host-tasks.js";
import type {
  ReactiveCommandInput,
  ReactiveJobReceipt,
  ReactiveJobRecord,
  ReactiveJobTerminalListener,
} from "./reactive-command.js";
import { TaskPipelineRunner } from "./task-pipeline.js";

class FakeReactiveCommands {
  readonly starts: ReactiveCommandInput[] = [];
  readonly jobs = new Map<string, ReactiveJobRecord>();
  private readonly listeners = new Set<ReactiveJobTerminalListener>();
  private sequence = 0;

  start(input: ReactiveCommandInput): ReactiveJobReceipt {
    this.sequence += 1;
    const jobId = `job_${String(this.sequence).padStart(32, "0")}`;
    const receipt: ReactiveJobReceipt = {
      job_id: jobId,
      status: "running",
      event_type: input.event_type ?? "process.exited",
      evidence_ref: `flyto2://evidence/${jobId}`,
      command_digest: `digest-${this.sequence}`,
      started_at: "2026-01-01T00:00:00.000Z",
    };
    this.starts.push(input);
    this.jobs.set(jobId, {
      job_id: jobId,
      workspace_id: input.workspace_id,
      command_digest: receipt.command_digest,
      event_type: receipt.event_type,
      status: "running",
      evidence_ref: receipt.evidence_ref,
      started_at: receipt.started_at,
    });
    return receipt;
  }

  get(jobId: string): ReactiveJobRecord | undefined {
    return this.jobs.get(jobId);
  }

  onTerminal(listener: ReactiveJobTerminalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  finish(
    jobId: string,
    status: "completed" | "failed" | "orphaned",
    exitCode?: number,
  ): void {
    const current = this.jobs.get(jobId);
    assert.ok(current);
    const terminal: ReactiveJobRecord = {
      ...current,
      status,
      completed_at: "2026-01-01T00:00:05.000Z",
      exit_code: exitCode,
    };
    this.jobs.set(jobId, terminal);
    for (const listener of this.listeners) listener(terminal);
  }
}

test("TaskPipelineRunner advances deterministic stages without ChatGPT polling", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-task-pipeline-"));
  const store = new HostTaskStore(stateDir);
  const commands = new FakeReactiveCommands();
  const runner = new TaskPipelineRunner(store, commands);
  t.after(async () => {
    runner.shutdown();
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const task = store.create({
    workspaceId: "ws_1",
    workspaceRoot: "/workspace",
    prompt: "Validate and deploy.",
    plan: {
      currentStage: 1,
      autoRun: true,
      stages: [
        { title: "Test", status: "running", command: "npm test" },
        { title: "Build", status: "pending", command: "npm run build" },
      ],
    },
  });

  const started = runner.start(task.id);
  assert.equal(commands.starts.length, 1);
  assert.equal(started?.plan?.activeJobId, "job_00000000000000000000000000000001");

  commands.finish("job_00000000000000000000000000000001", "completed", 0);
  const second = store.get(task.id);
  assert.equal(commands.starts.length, 2);
  assert.equal(second?.plan?.currentStage, 2);
  assert.equal(second?.plan?.stages[0]?.status, "done");
  assert.equal(second?.plan?.activeJobId, "job_00000000000000000000000000000002");

  commands.finish("job_00000000000000000000000000000002", "completed", 0);
  const completed = store.get(task.id);
  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.plan?.stages.map((stage) => stage.status), ["done", "done"]);
  assert.equal(completed?.plan?.activeJobId, undefined);
});

test("TaskPipelineRunner blocks on command failure instead of advancing", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-task-pipeline-fail-"));
  const store = new HostTaskStore(stateDir);
  const commands = new FakeReactiveCommands();
  const runner = new TaskPipelineRunner(store, commands);
  t.after(async () => {
    runner.shutdown();
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const task = store.create({
    workspaceId: "ws_1",
    workspaceRoot: "/workspace",
    prompt: "Run safe deployment gates.",
    plan: {
      currentStage: 1,
      autoRun: true,
      stages: [
        { title: "Verify", status: "running", command: "verify" },
        { title: "Push", status: "pending", command: "push" },
      ],
    },
  });

  runner.start(task.id);
  commands.finish("job_00000000000000000000000000000001", "failed", 1);
  const blocked = store.get(task.id);
  assert.equal(commands.starts.length, 1);
  assert.equal(blocked?.status, "active");
  assert.equal(blocked?.plan?.currentStage, 1);
  assert.equal(blocked?.plan?.stages[0]?.status, "blocked");
  assert.match(blocked?.plan?.stages[0]?.summary ?? "", /exit code 1/);
  assert.equal(blocked?.plan?.stages[1]?.status, "pending");
});

test("TaskPipelineRunner treats an orphaned restart outcome as blocked and never retries", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-task-pipeline-orphan-"));
  const store = new HostTaskStore(stateDir);
  const commands = new FakeReactiveCommands();
  const task = store.create({
    workspaceId: "ws_1",
    workspaceRoot: "/workspace",
    prompt: "Push once.",
    plan: {
      currentStage: 1,
      autoRun: true,
      activeJobId: "job_orphaned",
      stages: [
        { title: "Push", status: "running", command: "git push" },
      ],
    },
  });
  commands.jobs.set("job_orphaned", {
    job_id: "job_orphaned",
    workspace_id: "ws_1",
    command_digest: "digest",
    event_type: "task.stage.exited",
    status: "orphaned",
    evidence_ref: "flyto2://evidence/job_orphaned",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:05.000Z",
  });

  const runner = new TaskPipelineRunner(store, commands);
  t.after(async () => {
    runner.shutdown();
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => setImmediate(resolve));

  const blocked = store.get(task.id);
  assert.equal(commands.starts.length, 0);
  assert.equal(blocked?.plan?.stages[0]?.status, "blocked");
  assert.match(blocked?.plan?.stages[0]?.summary ?? "", /outcome is uncertain/);
});
