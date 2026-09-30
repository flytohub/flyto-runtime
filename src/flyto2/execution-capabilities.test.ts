import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { createReviewCheckpointManager } from "../review-checkpoints.js";
import { writeTestDevspaceConfig } from "../test-support/config.test.js";
import { createWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { createRuntimeCapabilityRegistry } from "./capability-runtime.js";
import { DurableOperationStore } from "./durable-operations.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  type Flyto2CapabilityInvocation,
} from "./protocol.js";
import {
  reactiveJobIdFromSessionId,
  ReactiveCommandRunner,
} from "./reactive-command.js";
import { RuntimeEventStore } from "./runtime-events.js";

test("test.run uses a declared package script once and exposes durable process status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-execution-capabilities-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({
    packageManager: "npm@11.6.1",
    scripts: {
      test: "node -e \"console.log('capability-test-ok'); setTimeout(() => process.exit(0), 120)\"",
      build: "node -e \"process.exit(0)\"",
    },
  }));

  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, ".worktrees"),
    },
    storage: { stateDir: join(root, ".state") },
    tools: { mode: "codex" },
  }));
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const runtimeEvents = new RuntimeEventStore(config.stateDir);
  const reactiveCommands = new ReactiveCommandRunner(config.stateDir, runtimeEvents);
  const durableOperations = new DurableOperationStore(config.stateDir);
  const registry = createRuntimeCapabilityRegistry({
    workspaces,
    reviewCheckpoints,
    runtimeEvents,
    execution: { reactiveCommands, durableOperations },
    observability: { reactiveCommands },
  });
  t.after(async () => {
    reactiveCommands.shutdown();
    durableOperations.close();
    runtimeEvents.close();
    workspaceStore.close?.();
    await rm(root, { recursive: true, force: true });
  });

  const opened = await registry.execute(invocation("open", "workspace.open", { path: project }));
  assert.equal(opened.status, "success");
  const workspaceId = String(opened.output.workspace_id);

  const run = invocation("test-run", "test.run", { workspace_id: workspaceId });
  const started = await registry.execute(run);
  assert.equal(started.status, "accepted");
  assert.equal(started.operation?.kind, "process");
  assert.equal(started.operation?.wait?.capability, "event.wait");
  assert.equal(started.operation?.inspect?.capability, "process.status");
  const sessionId = String(started.operation?.ref);
  const jobId = reactiveJobIdFromSessionId(sessionId);
  await new Promise<void>((resolve, reject) => {
    const existing = reactiveCommands.get(jobId);
    if (existing?.status !== "running") return resolve();
    const timer = setTimeout(() => {
      off();
      reject(new Error("test.run did not reach a terminal process state"));
    }, 5_000);
    const off = reactiveCommands.onTerminal((job) => {
      if (job.job_id !== jobId) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });

  const status = await registry.execute(invocation("status", "process.status", {
    workspace_id: workspaceId,
    session_id: sessionId,
  }));
  assert.equal(status.status, "success");
  assert.equal(status.output.status, "completed");
  assert.equal(status.output.exit_code, 0);

  const waitFollowUp = started.operation?.wait;
  assert.ok(waitFollowUp);
  const waited = await registry.execute(invocation("wait", waitFollowUp.capability, waitFollowUp.input));
  assert.equal(waited.status, "success");
  assert.equal(waited.output.matched, true);

  const evidenceRef = String(started.evidence[0]?.ref);
  const evidence = await registry.execute(invocation("evidence", "evidence.read", {
    workspace_id: workspaceId,
    ref: evidenceRef,
  }));
  assert.equal(evidence.status, "success");
  assert.match(String(evidence.output.text), /capability-test-ok/);

  const replay = await registry.execute(run);
  assert.equal(replay.status, "success");
  assert.equal(replay.output.replayed, true);
  assert.equal(
    runtimeEvents.list({ type: "process.started" }).filter(({ workspace_id }) => workspace_id === workspaceId).length,
    1,
  );

  const build = await registry.execute(invocation("build-run", "build.run", {
    workspace_id: workspaceId,
  }));
  assert.ok(build.status === "accepted" || build.status === "success");
});

test("test.run refuses projects without a declared test script", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-execution-capabilities-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ scripts: {} }));
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    storage: { stateDir: join(root, ".state") },
    tools: { mode: "codex" },
  }));
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const runtimeEvents = new RuntimeEventStore(config.stateDir);
  const reactiveCommands = new ReactiveCommandRunner(config.stateDir, runtimeEvents);
  const durableOperations = new DurableOperationStore(config.stateDir);
  const registry = createRuntimeCapabilityRegistry({
    workspaces,
    reviewCheckpoints,
    runtimeEvents,
    execution: { reactiveCommands, durableOperations },
  });
  t.after(async () => {
    reactiveCommands.shutdown();
    durableOperations.close();
    runtimeEvents.close();
    workspaceStore.close?.();
    await rm(root, { recursive: true, force: true });
  });
  const opened = await registry.execute(invocation("open-missing", "workspace.open", { path: project }));
  const result = await registry.execute(invocation("test-missing", "test.run", {
    workspace_id: String(opened.output.workspace_id),
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "script_unavailable");
});

function invocation(
  invocationId: string,
  capability: string,
  input: Record<string, unknown>,
): Flyto2CapabilityInvocation {
  return {
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    invocation_id: invocationId,
    capability,
    revision: 1,
    operation_id: `operation-${invocationId}`,
    requested_at: "2026-09-30T00:00:00.000Z",
    input,
  };
}
