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
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  type Flyto2CapabilityInvocation,
} from "./protocol.js";
import { ReactiveCommandRunner } from "./reactive-command.js";
import { RuntimeEventStore } from "./runtime-events.js";

test("observability providers are optional and enforce workspace ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-observability-"));
  const projectA = join(root, "a");
  const projectB = join(root, "b");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  await writeFile(join(projectA, "README.md"), "a\n");
  await writeFile(join(projectB, "README.md"), "b\n");
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
  t.after(async () => {
    reactiveCommands.shutdown();
    runtimeEvents.close();
    workspaceStore.close?.();
    await rm(root, { recursive: true, force: true });
  });

  const base = createRuntimeCapabilityRegistry({
    workspaces,
    reviewCheckpoints,
    runtimeEvents,
  });
  assert.equal(base.registeredCapabilities().some(({ id }) => id === "event.wait"), false);

  const registry = createRuntimeCapabilityRegistry({
    workspaces,
    reviewCheckpoints,
    runtimeEvents,
    observability: { reactiveCommands },
  });
  const openedA = await registry.execute(invocation("open-a", "workspace.open", { path: projectA }));
  const openedB = await registry.execute(invocation("open-b", "workspace.open", { path: projectB }));
  const workspaceA = String(openedA.output.workspace_id);
  const workspaceB = String(openedB.output.workspace_id);
  const receipt = reactiveCommands.start({
    workspace_id: workspaceA,
    workspace_root: projectA,
    cwd: projectA,
    command: "node -e \"console.log('owned-evidence')\"",
    event_type: "capability.test.exited",
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("reactive evidence job did not complete"));
    }, 5_000);
    const off = reactiveCommands.onTerminal((job) => {
      if (job.job_id !== receipt.job_id) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });

  const waited = await registry.execute(invocation("wait-a", "event.wait", {
    workspace_id: workspaceA,
    correlation_id: receipt.job_id,
    type: receipt.event_type,
  }));
  assert.equal(waited.status, "success");
  assert.equal(waited.output.matched, true);

  const denied = await registry.execute(invocation("evidence-b", "evidence.read", {
    workspace_id: workspaceB,
    ref: receipt.evidence_ref,
  }));
  assert.equal(denied.status, "failed");
  assert.equal(denied.failure?.code, "evidence_not_found");
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
