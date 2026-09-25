import assert from "node:assert/strict";
import test from "node:test";
import { Result } from "better-result";
import { registerBackgroundTaskTool } from "./background-task.js";
import type { ToolRegistrationContext } from "./types.js";

type Handler = (input: Record<string, unknown>) => Promise<{
  isError?: boolean;
  structuredContent: Record<string, unknown>;
}>;

test("background_task starts a detached local task with a durable ownership prompt", async () => {
  let handler: Handler | undefined;
  let startInput: Record<string, unknown> | undefined;
  const context = {
    config: { subagents: { enabled: true } },
    server: {
      registerTool: (_name: string, _definition: unknown, registered: Handler) => {
        handler = registered;
      },
    },
    workspaces: {
      getWorkspace: async () => ({ root: "/workspace" }),
    },
    resolveLocalAgentProviders: () => [
      { id: "claude", enabled: true, available: true, usable: true },
    ],
    localAgents: {
      start: async (input: Record<string, unknown>) => {
        startInput = input;
        return Result.ok({
          id: "agt_12345678",
          workspaceId: "ws_1",
          workspaceRoot: "/workspace",
          profileName: "claude",
          provider: "claude",
          status: "running" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      },
    },
  } as unknown as ToolRegistrationContext;

  registerBackgroundTaskTool(context);
  assert.ok(handler);
  const response = await handler({
    action: "start",
    workspace_id: "ws_1",
    prompt: "Fix the failing tests.",
  });

  assert.equal(startInput?.target, "claude");
  assert.equal(startInput?.workspaceRoot, "/workspace");
  assert.match(String(startInput?.prompt), /Own this task through completion/);
  assert.match(String(startInput?.prompt), /create one focused local commit after verification/);
  assert.match(String(startInput?.prompt), /Never push unless the caller explicitly requests it/);
  assert.match(String(startInput?.prompt), /Fix the failing tests/);
  assert.deepEqual(response.structuredContent, {
    result: "Background task agt_12345678 is running independently. It will continue if this conversation disconnects.",
    task_id: "agt_12345678",
    status: "running",
    provider: "claude",
    response: undefined,
    error: undefined,
    retry_after_ms: 5_000,
  });
});

test("background_task keeps completed responses lazy", async () => {
  let handler: Handler | undefined;
  const context = {
    config: { subagents: { enabled: true } },
    server: {
      registerTool: (_name: string, _definition: unknown, registered: Handler) => {
        handler = registered;
      },
    },
    workspaces: {
      getWorkspace: async () => ({ root: "/workspace" }),
    },
    resolveLocalAgentProviders: () => [],
    localAgents: {
      get: async () => Result.ok({
        id: "agt_12345678",
        workspaceId: "ws_1",
        workspaceRoot: "/workspace",
        profileName: "claude",
        provider: "claude",
        status: "idle" as const,
        latestResponse: "Finished and verified.",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    },
  } as unknown as ToolRegistrationContext;

  registerBackgroundTaskTool(context);
  assert.ok(handler);
  const compact = await handler({
    action: "status",
    workspace_id: "ws_1",
    task_id: "agt_12345678",
  });
  assert.equal(compact.structuredContent.status, "completed");
  assert.equal(compact.structuredContent.response, undefined);

  const withResponse = await handler({
    action: "status",
    workspace_id: "ws_1",
    task_id: "agt_12345678",
    include_response: true,
  });
  assert.equal(withResponse.structuredContent.response, "Finished and verified.");
});

test("background_task is absent when local agents are disabled", () => {
  let registered = false;
  const context = {
    config: { subagents: { enabled: false } },
    server: { registerTool: () => { registered = true; } },
  } as unknown as ToolRegistrationContext;

  registerBackgroundTaskTool(context);
  assert.equal(registered, false);
});
