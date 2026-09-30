import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { createReviewCheckpointManager } from "../review-checkpoints.js";
import { writeTestDevspaceConfig } from "../test-support/config.test.js";
import { createWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import {
  READ_ONLY_RUNTIME_CAPABILITY_PROFILE,
  STANDALONE_RUNTIME_CAPABILITY_PROFILE,
  runtimeCapabilityProfile,
} from "./capability-bundles.js";
import {
  createRuntimeCapabilityRegistry,
  createStandaloneRuntimeCapabilityRegistry,
} from "./capability-runtime.js";
import { DurableOperationStore } from "./durable-operations.js";
import { ReactiveCommandRunner } from "./reactive-command.js";
import { RuntimeEventStore } from "./runtime-events.js";

test("read-only profile is independently composable without execution dependencies", async (t) => {
  const deps = await runtimeDependencies(t);
  const registry = createRuntimeCapabilityRegistry({
    workspaces: deps.workspaces,
    reviewCheckpoints: deps.reviewCheckpoints,
    runtimeEvents: deps.runtimeEvents,
    profile: READ_ONLY_RUNTIME_CAPABILITY_PROFILE,
  });
  assert.deepEqual(capabilityIds(registry), [
    "git.inspect",
    "review.diff",
    "source.read",
    "workspace.open",
  ]);
});

test("explicit bundle selection fails closed when required dependencies are absent", async (t) => {
  const deps = await runtimeDependencies(t);
  assert.throws(() => createRuntimeCapabilityRegistry({
    workspaces: deps.workspaces,
    reviewCheckpoints: deps.reviewCheckpoints,
    runtimeEvents: deps.runtimeEvents,
    profile: runtimeCapabilityProfile("execution-only", ["execution"]),
  }), /bundle execution was selected without its required dependencies/);
});

test("standalone profile explicitly registers the full production provider set", async (t) => {
  const deps = await runtimeDependencies(t);
  const registry = createStandaloneRuntimeCapabilityRegistry({
    workspaces: deps.workspaces,
    reviewCheckpoints: deps.reviewCheckpoints,
    runtimeEvents: deps.runtimeEvents,
    execution: {
      reactiveCommands: deps.reactiveCommands,
      durableOperations: deps.durableOperations,
    },
    mutation: { durableOperations: deps.durableOperations },
    observability: { reactiveCommands: deps.reactiveCommands },
  });
  assert.deepEqual(STANDALONE_RUNTIME_CAPABILITY_PROFILE.bundles, [
    "read",
    "execution",
    "mutation",
    "observability",
  ]);
  assert.deepEqual(capabilityIds(registry), [
    "build.run",
    "event.wait",
    "evidence.read",
    "git.inspect",
    "git.mutate",
    "process.status",
    "review.diff",
    "source.edit",
    "source.read",
    "test.run",
    "workspace.open",
  ]);
});

test("custom profiles compose only the requested provider bundles", async (t) => {
  const deps = await runtimeDependencies(t);
  const registry = createRuntimeCapabilityRegistry({
    workspaces: deps.workspaces,
    reviewCheckpoints: deps.reviewCheckpoints,
    runtimeEvents: deps.runtimeEvents,
    profile: runtimeCapabilityProfile("read-plus-observability", ["read", "observability", "read"]),
    observability: { reactiveCommands: deps.reactiveCommands },
  });
  assert.deepEqual(capabilityIds(registry), [
    "event.wait",
    "evidence.read",
    "git.inspect",
    "review.diff",
    "source.read",
    "workspace.open",
  ]);
});

function capabilityIds(registry: ReturnType<typeof createRuntimeCapabilityRegistry>): string[] {
  return registry.registeredCapabilities().map(({ id }) => id).sort();
}

async function runtimeDependencies(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "flyto2-capability-bundles-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
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
  t.after(async () => {
    reactiveCommands.shutdown();
    durableOperations.close();
    runtimeEvents.close();
    workspaceStore.close?.();
    await rm(root, { recursive: true, force: true });
  });
  return {
    workspaces,
    reviewCheckpoints,
    runtimeEvents,
    reactiveCommands,
    durableOperations,
  };
}
