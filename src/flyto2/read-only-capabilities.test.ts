import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { git } from "../git.js";
import { createReviewCheckpointManager } from "../review-checkpoints.js";
import { writeTestDevspaceConfig } from "../test-support/config.test.js";
import { createWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { createRuntimeCapabilityRegistry } from "./capability-runtime.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  type Flyto2CapabilityInvocation,
} from "./protocol.js";
import { RuntimeEventStore } from "./runtime-events.js";

test("read-only Runtime providers compose through the registry without exposing local roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-readonly-capabilities-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "README.md"), "hello provider\n");
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "runtime@example.com"]);
  await git(project, ["config", "user.name", "Runtime Test"]);
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "Initial commit"]);

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
  const registry = createRuntimeCapabilityRegistry({
    workspaces,
    reviewCheckpoints,
    runtimeEvents,
  });
  t.after(async () => {
    runtimeEvents.close();
    workspaceStore.close?.();
    await rm(root, { recursive: true, force: true });
  });

  const opened = await registry.execute(invocation("open-1", "workspace.open", {
    path: project,
  }, "trace-open"));
  assert.equal(opened.status, "success");
  const workspaceId = opened.output.workspace_id;
  assert.equal(typeof workspaceId, "string");
  assert.equal(opened.output.mode, "checkout");
  assert.equal("root" in opened.output, false);
  assert.equal("source_root" in opened.output, false);

  const reopened = await registry.execute(invocation("open-2", "workspace.open", {
    path: project,
  }, "trace-open"));
  assert.equal(reopened.status, "success");
  assert.equal(reopened.output.workspace_id, workspaceId);

  const read = await registry.execute(invocation("read-1", "source.read", {
    workspace_id: workspaceId,
    path: "README.md",
  }));
  assert.equal(read.status, "success");
  assert.match(String(read.output.result), /hello provider/);

  const inspected = await registry.execute(invocation("git-1", "git.inspect", {
    workspace_id: workspaceId,
  }));
  assert.equal(inspected.status, "success");
  assert.equal(inspected.output.available, true);
  assert.equal(inspected.output.dirty, false);
  assert.equal("git_root" in inspected.output, false);

  await writeFile(join(project, "README.md"), "hello provider\nchanged\n");
  const review1 = await registry.execute(invocation("review-1", "review.diff", {
    workspace_id: workspaceId,
  }));
  assert.equal(review1.status, "success");
  assert.deepEqual(review1.output.summary, { files: 1, additions: 1, removals: 0 });

  const review2 = await registry.execute(invocation("review-2", "review.diff", {
    workspace_id: workspaceId,
  }));
  assert.equal(review2.status, "success");
  assert.deepEqual(review2.output.summary, review1.output.summary);

  const worktreeOpen = await registry.execute(invocation("open-worktree", "workspace.open", {
    path: project,
    mode: "worktree",
  }));
  assert.equal(worktreeOpen.status, "failed");

  const auditEvents = runtimeEvents.list({ correlation_id: "read-1" });
  assert.deepEqual(auditEvents.map(({ type }) => type), [
    "capability.started",
    "capability.completed",
  ]);
  assert.ok(auditEvents.every(({ payload }) => !("input" in payload) && !("output" in payload)));
});

function invocation(
  invocationId: string,
  capability: string,
  input: Record<string, unknown>,
  traceId?: string,
): Flyto2CapabilityInvocation {
  return {
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    invocation_id: invocationId,
    capability,
    revision: 1,
    operation_id: `operation-${invocationId}`,
    trace_id: traceId,
    requested_at: "2026-09-30T00:00:00.000Z",
    input,
  };
}
