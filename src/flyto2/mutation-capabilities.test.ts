import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { DurableOperationStore } from "./durable-operations.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  type Flyto2CapabilityInvocation,
} from "./protocol.js";
import { RuntimeEventStore } from "./runtime-events.js";

test("mutation providers remain optional and source.edit replays without applying twice", async (t) => {
  const fixture = await mutationFixture(t);
  const readOnly = createRuntimeCapabilityRegistry({
    workspaces: fixture.workspaces,
    reviewCheckpoints: fixture.reviewCheckpoints,
    runtimeEvents: fixture.runtimeEvents,
  });
  assert.equal(readOnly.registeredCapabilities().some(({ id }) => id === "source.edit"), false);

  const registry = createRuntimeCapabilityRegistry({
    workspaces: fixture.workspaces,
    reviewCheckpoints: fixture.reviewCheckpoints,
    runtimeEvents: fixture.runtimeEvents,
    mutation: { durableOperations: fixture.durableOperations },
  });
  assert.equal(registry.registeredCapabilities().some(({ id }) => id === "source.edit"), true);
  assert.equal(registry.registeredCapabilities().some(({ id }) => id === "test.run"), false);

  const opened = await registry.execute(invocation("open-edit", "workspace.open", {
    path: fixture.project,
  }));
  const workspaceId = String(opened.output.workspace_id);
  const edit = invocation("edit-once", "source.edit", {
    workspace_id: workspaceId,
    patch: "*** Begin Patch\n*** Update File: README.md\n@@\n-before\n+after\n*** End Patch",
  });
  const first = await registry.execute(edit);
  assert.equal(first.status, "success");
  assert.equal(first.output.replayed, false);
  assert.equal(await readFile(join(fixture.project, "README.md"), "utf8"), "after\n");

  const replay = await registry.execute(edit);
  assert.equal(replay.status, "success");
  assert.equal(replay.output.replayed, true);
  assert.equal(await readFile(join(fixture.project, "README.md"), "utf8"), "after\n");
});

test("git.mutate stages only the workspace and commits staged workspace changes", async (t) => {
  const fixture = await mutationFixture(t);
  const registry = createRuntimeCapabilityRegistry({
    workspaces: fixture.workspaces,
    reviewCheckpoints: fixture.reviewCheckpoints,
    runtimeEvents: fixture.runtimeEvents,
    mutation: { durableOperations: fixture.durableOperations },
  });
  const opened = await registry.execute(invocation("open-git", "workspace.open", {
    path: fixture.project,
  }));
  const workspaceId = String(opened.output.workspace_id);

  await writeFile(join(fixture.project, "README.md"), "changed\n");
  const staged = await registry.execute(invocation("stage-workspace", "git.mutate", {
    workspace_id: workspaceId,
    action: "stage_workspace",
  }));
  assert.equal(staged.status, "success");
  assert.equal(staged.output.staged_count, 1);

  const before = (await git(fixture.project, ["rev-parse", "HEAD"])).stdout.trim();
  const committed = await registry.execute(invocation("commit-workspace", "git.mutate", {
    workspace_id: workspaceId,
    action: "commit_staged",
    message: "Update README",
  }));
  assert.equal(committed.status, "success");
  assert.match(String(committed.output.commit_sha), /^[0-9a-f]{40}$/);
  assert.notEqual(committed.output.commit_sha, before);
  assert.equal((await git(fixture.project, ["status", "--porcelain"])).stdout, "");
});

test("git.mutate refuses a commit when the index contains paths outside a sub-workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-mutation-scope-"));
  const project = join(root, "repo");
  const workspacePath = join(project, "app");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "inside.txt"), "inside\n");
  await writeFile(join(project, "outside.txt"), "outside\n");
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "runtime@example.com"]);
  await git(project, ["config", "user.name", "Runtime Test"]);
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "Initial commit"]);

  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [project], worktreeRoot: join(root, ".worktrees") },
    storage: { stateDir: join(root, ".state") },
    tools: { mode: "codex" },
  }));
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const runtimeEvents = new RuntimeEventStore(config.stateDir);
  const durableOperations = new DurableOperationStore(config.stateDir);
  t.after(async () => {
    durableOperations.close();
    runtimeEvents.close();
    workspaceStore.close?.();
    await rm(root, { recursive: true, force: true });
  });
  const registry = createRuntimeCapabilityRegistry({
    workspaces,
    reviewCheckpoints,
    runtimeEvents,
    mutation: { durableOperations },
  });
  const opened = await registry.execute(invocation("open-subdir", "workspace.open", {
    path: workspacePath,
  }));
  const workspaceId = String(opened.output.workspace_id);
  const before = (await git(project, ["rev-parse", "HEAD"])).stdout.trim();

  await writeFile(join(workspacePath, "inside.txt"), "inside changed\n");
  await writeFile(join(project, "outside.txt"), "outside changed\n");
  await git(project, ["add", "outside.txt"]);
  const staged = await registry.execute(invocation("stage-subdir", "git.mutate", {
    workspace_id: workspaceId,
    action: "stage_workspace",
  }));
  assert.equal(staged.status, "success");

  const commit = await registry.execute(invocation("commit-subdir", "git.mutate", {
    workspace_id: workspaceId,
    action: "commit_staged",
    message: "Scoped commit",
  }));
  assert.equal(commit.status, "failed");
  assert.equal(commit.failure?.code, "staged_changes_outside_workspace");
  assert.equal((await git(project, ["rev-parse", "HEAD"])).stdout.trim(), before);
});

async function mutationFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "flyto2-mutation-capabilities-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "README.md"), "before\n");
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "runtime@example.com"]);
  await git(project, ["config", "user.name", "Runtime Test"]);
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "Initial commit"]);
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
  const durableOperations = new DurableOperationStore(config.stateDir);
  t.after(async () => {
    durableOperations.close();
    runtimeEvents.close();
    workspaceStore.close?.();
    await rm(root, { recursive: true, force: true });
  });
  return {
    project,
    workspaces,
    reviewCheckpoints,
    runtimeEvents,
    durableOperations,
  };
}

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
