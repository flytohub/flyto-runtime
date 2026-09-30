import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Result } from "better-result";
import { loadConfig } from "../config.js";
import { AgentTargetError } from "../local-agent-errors.js";
import type { LocalAgentRecord } from "../local-agent-store.js";
import { createReviewCheckpointManager } from "../review-checkpoints.js";
import { writeTestDevspaceConfig } from "../test-support/config.test.js";
import { createWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { runtimeCapabilityProfile } from "./capability-bundles.js";
import { createRuntimeCapabilityRegistry } from "./capability-runtime.js";
import { DurableOperationStore } from "./durable-operations.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  type Flyto2CapabilityInvocation,
} from "./protocol.js";
import { RuntimeEventStore } from "./runtime-events.js";

test("agent bundle delegates once, returns a provider-neutral handle, and replays safely", async (t) => {
  const deps = await dependencies(t);
  let starts = 0;
  let record = agentRecord("running");
  const client = {
    async start() {
      starts += 1;
      return Result.ok(record);
    },
    async continue() { return Result.ok(record); },
    async get() { return Result.ok(record); },
    async wait() { return Result.ok([{ id: record.id, status: "running" as const }]); },
  } as never;
  const registry = createRuntimeCapabilityRegistry({
    ...deps.registryBase,
    profile: runtimeCapabilityProfile("agent-only", ["agent"]),
    agent: { client, durableOperations: deps.durableOperations },
  });

  const request = invocation("delegate-1", "agent.delegate", {
    workspace_id: deps.workspaceId,
    target: "codex",
    prompt: "Inspect the repository without changing files.",
  });
  const first = await registry.execute(request);
  assert.equal(first.status, "accepted");
  assert.equal(first.operation?.kind, "agent");
  assert.equal(first.operation?.ref, "agt_test");
  assert.equal(first.operation?.wait?.capability, "agent.wait");
  assert.equal(first.operation?.wait?.input.workspace_id, deps.workspaceId);
  assert.equal(first.operation?.inspect?.capability, "agent.inspect");
  assert.equal(first.operation?.inspect?.input.workspace_id, deps.workspaceId);
  assert.equal((first.output as { provider?: unknown }).provider, undefined);
  assert.equal(starts, 1);

  record = { ...record, status: "idle", latestResponse: "inspection complete" };
  const replay = await registry.execute(request);
  assert.equal(replay.status, "success");
  assert.equal(replay.output.response, "inspection complete");
  assert.equal(replay.output.replayed, true);
  assert.equal(starts, 1);
});

test("agent bundle scopes observation and converts agent errors without leaking local provider config", async (t) => {
  const deps = await dependencies(t);
  const client = {
    async start() {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_DISABLED",
        target: "claude",
        retryable: false,
        message: "Subagent profile is disabled at /Users/private/runtime/credentials: claude.",
      }));
    },
    async continue() { return Result.ok(agentRecord("running")); },
    async get() { return Result.ok(agentRecord("running")); },
    async wait() { return Result.ok([{ id: "agt_test", status: "running" as const }]); },
  } as never;
  const registry = createRuntimeCapabilityRegistry({
    ...deps.registryBase,
    profile: runtimeCapabilityProfile("agent-only", ["agent"]),
    agent: { client, durableOperations: deps.durableOperations },
  });

  const result = await registry.execute(invocation("delegate-disabled", "agent.delegate", {
    workspace_id: deps.workspaceId,
    target: "claude",
    prompt: "Inspect only.",
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "PROVIDER_DISABLED");
  assert.doesNotMatch(JSON.stringify(result), /\/Users\/private/);
  assert.doesNotMatch(JSON.stringify(result), /api[_-]?key|token|secret/i);
});

async function dependencies(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "flyto2-agent-capability-"));
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
  const runtimeEvents = new RuntimeEventStore(config.stateDir);
  const durableOperations = new DurableOperationStore(config.stateDir);
  const reviewCheckpoints = createReviewCheckpointManager();
  const opened = await workspaces.openWorkspace(project);
  t.after(async () => {
    durableOperations.close();
    runtimeEvents.close();
    workspaceStore.close?.();
    await rm(root, { recursive: true, force: true });
  });
  return {
    workspaceId: opened.workspace.id,
    durableOperations,
    registryBase: { workspaces, reviewCheckpoints, runtimeEvents },
  };
}

function agentRecord(status: LocalAgentRecord["status"]): LocalAgentRecord {
  return {
    id: "agt_test",
    workspaceId: "ws_test",
    workspaceRoot: "/tmp/provider-private-root",
    profileName: "private-profile",
    provider: "private-provider",
    status,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  };
}

function invocation(
  id: string,
  capability: string,
  input: Record<string, unknown>,
): Flyto2CapabilityInvocation {
  return {
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    invocation_id: id,
    capability,
    revision: 1,
    operation_id: `operation-${id}`,
    requested_at: "2026-09-30T00:00:00.000Z",
    input,
  };
}
