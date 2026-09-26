import assert from "node:assert/strict";
import test from "node:test";
import { registerBackgroundTaskTool } from "./background-task.js";
import type { ToolRegistrationContext } from "./types.js";
import type { HostTaskRecord } from "../flyto2/host-tasks.js";

type Handler = (input: Record<string, unknown>) => Promise<{
  isError?: boolean;
  structuredContent: Record<string, unknown>;
}>;

function fixture() {
  let handler: Handler | undefined;
  const records = new Map<string, HostTaskRecord>();
  let sequence = 0;
  const context = {
    config: {
      toolMode: "codex",
    },
    server: {
      registerTool: (_name: string, _definition: unknown, registered: Handler) => {
        handler = registered;
      },
    },
    workspaces: {
      getWorkspace: async () => ({ root: "/workspace" }),
    },
    hostTasks: {
      create: (input: { workspaceId: string; workspaceRoot: string; prompt: string }) => {
        sequence += 1;
        const now = "2026-01-01T00:00:00.000Z";
        const record: HostTaskRecord = {
          id: `task_${String(sequence).padStart(32, "0")}`,
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
          prompt: input.prompt,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        records.set(record.id, record);
        return record;
      },
      get: (id: string) => records.get(id),
      findLatestActiveByRoot: (workspaceRoot: string) =>
        Array.from(records.values())
          .filter((record) => record.workspaceRoot === workspaceRoot && record.status === "active")
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0],
      adoptActive: (id: string, workspaceId: string, workspaceRoot: string) => {
        const current = records.get(id);
        if (!current || current.workspaceRoot !== workspaceRoot || current.status !== "active") {
          return current;
        }
        const updated = {
          ...current,
          workspaceId,
          updatedAt: "2026-01-01T00:01:30.000Z",
        };
        records.set(id, updated);
        return updated;
      },
      checkpoint: (id: string, checkpoint: string) => {
        const current = records.get(id);
        if (!current) return undefined;
        const updated = { ...current, checkpoint, updatedAt: "2026-01-01T00:01:00.000Z" };
        records.set(id, updated);
        return updated;
      },
      complete: (id: string, result?: string) => {
        const current = records.get(id);
        if (!current) return undefined;
        const updated: HostTaskRecord = {
          ...current,
          status: "completed",
          result,
          updatedAt: "2026-01-01T00:02:00.000Z",
          completedAt: "2026-01-01T00:02:00.000Z",
        };
        records.set(id, updated);
        return updated;
      },
      stop: (id: string, result?: string) => {
        const current = records.get(id);
        if (!current) return undefined;
        const updated: HostTaskRecord = {
          ...current,
          status: "stopped",
          result,
          updatedAt: "2026-01-01T00:02:00.000Z",
          completedAt: "2026-01-01T00:02:00.000Z",
        };
        records.set(id, updated);
        return updated;
      },
    },
  } as unknown as ToolRegistrationContext;

  registerBackgroundTaskTool(context);
  assert.ok(handler);
  return { handler, records };
}

test("background_task records a ChatGPT-owned durable task without delegating", async () => {
  const { handler } = fixture();
  const response = await handler({
    action: "start",
    workspace_id: "ws_1",
    prompt: "Fix the failing tests.",
  });

  assert.equal(response.structuredContent.status, "running");
  assert.match(String(response.structuredContent.task_id), /^task_/);
  assert.match(String(response.structuredContent.result), /recorded for ChatGPT/);
  assert.match(String(response.structuredContent.result), /will not start another model or local-agent provider/);
  assert.equal("provider" in response.structuredContent, false);
});

test("background_task persists checkpoints and returns them after reconnect", async () => {
  const { handler } = fixture();
  const started = await handler({
    action: "start",
    workspace_id: "ws_1",
    prompt: "Implement durable host recovery.",
  });
  const taskId = String(started.structuredContent.task_id);

  const checkpointed = await handler({
    action: "continue",
    workspace_id: "ws_1",
    task_id: taskId,
    prompt: "Source edit complete; tests still need to run.",
  });
  assert.equal(checkpointed.structuredContent.status, "running");

  const status = await handler({
    action: "status",
    workspace_id: "ws_1",
    task_id: taskId,
    include_response: true,
  });
  assert.equal(status.structuredContent.original_prompt, "Implement durable host recovery.");
  assert.equal(status.structuredContent.checkpoint, "Source edit complete; tests still need to run.");
  assert.equal(status.structuredContent.response, undefined);
});

test("background_task wait never implies another model is running", async () => {
  const { handler } = fixture();
  const started = await handler({
    action: "start",
    workspace_id: "ws_1",
    prompt: "Run the task.",
  });
  const taskId = String(started.structuredContent.task_id);

  const waited = await handler({
    action: "wait",
    workspace_id: "ws_1",
    task_id: taskId,
  });
  assert.equal(waited.structuredContent.status, "running");
  assert.match(String(waited.structuredContent.result), /There is no background model to wait for/);
});

test("background_task stores completion result for a later ChatGPT session", async () => {
  const { handler } = fixture();
  const started = await handler({
    action: "start",
    workspace_id: "ws_1",
    prompt: "Finish the change.",
  });
  const taskId = String(started.structuredContent.task_id);

  const completed = await handler({
    action: "complete",
    workspace_id: "ws_1",
    task_id: taskId,
    prompt: "Tests pass; committed as abc1234.",
    include_response: true,
  });
  assert.equal(completed.structuredContent.status, "completed");
  assert.equal(completed.structuredContent.response, "Tests pass; committed as abc1234.");
});

test("background_task keeps ChatGPT recovery previews compact", async () => {
  const { handler } = fixture();
  const response = await handler({
    action: "start",
    workspace_id: "ws_1",
    prompt: "p".repeat(10_000),
    include_response: true,
  });

  const prompt = String(response.structuredContent.original_prompt);
  assert.ok(prompt.length < 3_100);
  assert.match(prompt, /Response truncated/);
});

test("background_task rejects cross-repo task access", async () => {
  const { handler, records } = fixture();
  const started = await handler({
    action: "start",
    workspace_id: "ws_1",
    prompt: "Keep task scoped.",
  });
  const taskId = String(started.structuredContent.task_id);
  const current = records.get(taskId);
  assert.ok(current);
  records.set(taskId, { ...current, workspaceRoot: "/different-repo" });

  const response = await handler({
    action: "status",
    workspace_id: "ws_2",
    task_id: taskId,
  });
  assert.equal(response.isError, true);
  assert.match(String(response.structuredContent.result), /does not belong to this workspace/);
});

test("background_task adopts an active task into a new ChatGPT workspace for the same repo", async () => {
  const { handler, records } = fixture();
  const started = await handler({
    action: "start",
    workspace_id: "ws_old",
    prompt: "Continue this after opening a new chat.",
  });
  const taskId = String(started.structuredContent.task_id);

  const recovered = await handler({
    action: "status",
    workspace_id: "ws_new",
    task_id: taskId,
    include_response: true,
  });

  assert.equal(recovered.isError, undefined);
  assert.equal(recovered.structuredContent.status, "running");
  assert.equal(records.get(taskId)?.workspaceId, "ws_new");
  assert.equal(
    recovered.structuredContent.original_prompt,
    "Continue this after opening a new chat.",
  );
});

test("background_task status without task_id recovers the latest active task for the repo", async () => {
  const { handler, records } = fixture();
  const started = await handler({
    action: "start",
    workspace_id: "ws_old",
    prompt: "Recover me automatically.",
  });
  const taskId = String(started.structuredContent.task_id);
  await handler({
    action: "continue",
    workspace_id: "ws_old",
    task_id: taskId,
    prompt: "Checkpoint from the old conversation.",
  });

  const recovered = await handler({
    action: "status",
    workspace_id: "ws_new",
    include_response: true,
  });

  assert.equal(recovered.structuredContent.task_id, taskId);
  assert.equal(
    recovered.structuredContent.checkpoint,
    "Checkpoint from the old conversation.",
  );
  assert.match(String(recovered.structuredContent.result), /previous ChatGPT workspace/);
  assert.equal(records.get(taskId)?.workspaceId, "ws_new");
});
