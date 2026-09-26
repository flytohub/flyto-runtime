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
      getWorkspace: async (workspaceId: string) => {
        if (workspaceId === "ws_source") return { root: "/repo" };
        if (workspaceId === "ws_worktree") {
          return { root: "/managed/repo-wt", sourceRoot: "/repo" };
        }
        if (workspaceId === "ws_worktree_2") {
          return { root: "/managed/repo-wt-2", sourceRoot: "/repo" };
        }
        if (workspaceId === "ws_other_repo") return { root: "/other-repo" };
        return { root: "/workspace" };
      },
    },
    hostTasks: {
      create: (input: {
        workspaceId: string;
        workspaceRoot: string;
        repoRoot?: string;
        prompt: string;
        plan?: HostTaskRecord["plan"];
      }) => {
        sequence += 1;
        const now = "2026-01-01T00:00:00.000Z";
        const record: HostTaskRecord = {
          id: `task_${String(sequence).padStart(32, "0")}`,
          workspaceId: input.workspaceId,
          repoRoot: input.repoRoot ?? input.workspaceRoot,
          workspaceRoot: input.workspaceRoot,
          prompt: input.prompt,
          status: "active",
          plan: input.plan,
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
      findLatestByRoot: (workspaceRoot: string) =>
        Array.from(records.values())
          .filter((record) => record.workspaceRoot === workspaceRoot)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0],
      findLatestActiveByRepoRoot: (repoRoot: string) =>
        Array.from(records.values())
          .filter((record) => record.repoRoot === repoRoot && record.status === "active")
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0],
      findLatestByRepoRoot: (repoRoot: string) =>
        Array.from(records.values())
          .filter((record) => record.repoRoot === repoRoot)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0],
      adoptActive: (
        id: string,
        workspaceId: string,
        workspaceRoot: string,
        repoRoot = workspaceRoot,
      ) => {
        const current = records.get(id);
        if (!current || current.repoRoot !== repoRoot || current.status !== "active") {
          return current;
        }
        const updated = {
          ...current,
          workspaceId,
          workspaceRoot,
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
      updatePlan: (
        id: string,
        input: {
          currentStage?: number;
          stageStatus?: "pending" | "running" | "done" | "blocked";
          stageSummary?: string;
          activeSessionId?: string | null;
        },
      ) => {
        const current = records.get(id);
        if (!current?.plan) return current;
        const stage = input.currentStage ?? current.plan.currentStage;
        const stages = current.plan.stages.map((item, index) => {
          const stageNumber = index + 1;
          if (stageNumber < stage && item.status !== "blocked") {
            return { ...item, status: "done" as const };
          }
          if (stageNumber !== stage) return item;
          return {
            ...item,
            status: input.stageStatus ?? "running",
            ...(input.stageSummary !== undefined ? { summary: input.stageSummary } : {}),
          };
        });
        const updated: HostTaskRecord = {
          ...current,
          plan: {
            currentStage: stage,
            stages,
            activeSessionId: input.activeSessionId === null
              ? undefined
              : input.activeSessionId,
          },
          updatedAt: "2026-01-01T00:01:45.000Z",
        };
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
    taskPipelines: {
      start: (id: string) => records.get(id),
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
  assert.equal(response.structuredContent.workspace_id, "ws_1");
  assert.equal(response.structuredContent.workspace_root, "/workspace");
  assert.equal(response.structuredContent.repository_root, "/workspace");
  assert.equal(response.structuredContent.updated_at, "2026-01-01T00:00:00.000Z");
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
  records.set(taskId, { ...current, repoRoot: "/different-repo" });

  const response = await handler({
    action: "status",
    workspace_id: "ws_2",
    task_id: taskId,
  });
  assert.equal(response.isError, true);
  assert.match(String(response.structuredContent.result), /does not belong to this repository/);
});

test("background_task follows one durable task from source checkout into a managed worktree", async () => {
  const { handler, records } = fixture();
  const started = await handler({
    action: "start",
    workspace_id: "ws_source",
    prompt: "Continue this task in an isolated worktree.",
  });
  const taskId = String(started.structuredContent.task_id);
  assert.equal(started.structuredContent.workspace_root, "/repo");
  assert.equal(started.structuredContent.repository_root, "/repo");

  const recovered = await handler({
    action: "status",
    workspace_id: "ws_worktree",
    include_response: true,
  });

  assert.equal(recovered.isError, undefined);
  assert.equal(recovered.structuredContent.task_id, taskId);
  assert.equal(recovered.structuredContent.workspace_id, "ws_worktree");
  assert.equal(recovered.structuredContent.workspace_root, "/managed/repo-wt");
  assert.equal(recovered.structuredContent.repository_root, "/repo");
  assert.equal(records.get(taskId)?.workspaceRoot, "/managed/repo-wt");
  assert.equal(records.get(taskId)?.repoRoot, "/repo");
});

test("background_task never switches execution roots while a durable stage is still in flight", async () => {
  const { handler, records } = fixture();
  const started = await handler({
    action: "start",
    workspace_id: "ws_worktree",
    prompt: "Keep the running stage pinned to its worktree.",
    plan: ["Long test", "Deploy"],
  });
  const taskId = String(started.structuredContent.task_id);
  const current = records.get(taskId);
  assert.ok(current?.plan);
  records.set(taskId, {
    ...current,
    plan: { ...current.plan, activeSessionId: "proc_running" },
  });

  const recovered = await handler({
    action: "status",
    workspace_id: "ws_worktree_2",
    task_id: taskId,
  });

  assert.equal(recovered.isError, undefined);
  assert.equal(recovered.structuredContent.workspace_root, "/managed/repo-wt");
  assert.equal(recovered.structuredContent.repository_root, "/repo");
  assert.equal(records.get(taskId)?.workspaceId, "ws_worktree");
  assert.equal(records.get(taskId)?.workspaceRoot, "/managed/repo-wt");
});

test("background_task can release manual-session pinning before adopting a new worktree", async () => {
  const { handler, records } = fixture();
  const started = await handler({
    action: "start",
    workspace_id: "ws_worktree",
    prompt: "Move after the manual command finishes.",
    plan: ["Validate", "Commit"],
  });
  const taskId = String(started.structuredContent.task_id);
  await handler({
    action: "continue",
    workspace_id: "ws_worktree",
    task_id: taskId,
    active_session_id: "proc_finished",
  });
  await handler({
    action: "continue",
    workspace_id: "ws_worktree",
    task_id: taskId,
    active_session_id: null,
  });

  const recovered = await handler({
    action: "status",
    workspace_id: "ws_worktree_2",
    task_id: taskId,
  });
  assert.equal(recovered.structuredContent.workspace_root, "/managed/repo-wt-2");
  assert.equal(records.get(taskId)?.workspaceId, "ws_worktree_2");
  assert.equal(records.get(taskId)?.workspaceRoot, "/managed/repo-wt-2");
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
  assert.equal(recovered.structuredContent.workspace_id, "ws_new");
  assert.equal(recovered.structuredContent.workspace_root, "/workspace");
  assert.equal(recovered.structuredContent.updated_at, "2026-01-01T00:01:30.000Z");
  assert.equal(
    recovered.structuredContent.checkpoint,
    "Checkpoint from the old conversation.",
  );
  assert.match(String(recovered.structuredContent.result), /previous ChatGPT workspace/);
  assert.equal(records.get(taskId)?.workspaceId, "ws_new");
});

test("background_task preserves a five-stage plan so a new chat knows stages 4 and 5 remain", async () => {
  const { handler } = fixture();
  const started = await handler({
    action: "start",
    workspace_id: "ws_old",
    prompt: "Complete the five-stage release.",
    plan: ["Audit", "Refactor", "Test", "Deploy", "Live verify"],
  });
  const taskId = String(started.structuredContent.task_id);

  const progressed = await handler({
    action: "continue",
    workspace_id: "ws_old",
    task_id: taskId,
    current_stage: 3,
    stage_status: "running",
    stage_summary: "Focused tests passed; full suite is still running.",
    active_session_id: "proc_long_test",
    prompt: "Reached stage 3; do not skip deploy or live verify.",
  });

  const plan = progressed.structuredContent.plan as {
    current_stage: number;
    total_stages: number;
    active_session_id?: string;
    stages: Array<{ index: number; title: string; status: string; summary?: string }>;
  };
  assert.equal(plan.current_stage, 3);
  assert.equal(plan.total_stages, 5);
  assert.equal(plan.active_session_id, "proc_long_test");
  assert.deepEqual(plan.stages.map((stage) => stage.status), [
    "done",
    "done",
    "running",
    "pending",
    "pending",
  ]);
  assert.equal(plan.stages[2]?.summary, "Focused tests passed; full suite is still running.");

  const recovered = await handler({
    action: "status",
    workspace_id: "ws_new",
    include_response: true,
  });
  const recoveredPlan = recovered.structuredContent.plan as typeof plan;
  assert.equal(recoveredPlan.current_stage, 3);
  assert.equal(recoveredPlan.stages[3]?.title, "Deploy");
  assert.equal(recoveredPlan.stages[3]?.status, "pending");
  assert.equal(recoveredPlan.stages[4]?.title, "Live verify");
  assert.equal(recoveredPlan.stages[4]?.status, "pending");
  assert.equal(recoveredPlan.active_session_id, "proc_long_test");
  assert.match(String(recovered.structuredContent.result), /Progress 3\/5: Test \(running\)/);
});

test("background_task keeps deterministic commands local while exposing automation state", async () => {
  const { handler } = fixture();
  const response = await handler({
    action: "start",
    workspace_id: "ws_1",
    prompt: "Validate and deploy.",
    plan: [
      { title: "Test", command: "npm test" },
      { title: "Build", command: "npm run build", timeout_seconds: 120 },
      "Review",
    ],
    auto_run: true,
  });
  const plan = response.structuredContent.plan as {
    stages: Array<Record<string, unknown>>;
  };
  assert.equal(plan.stages[0]?.automated, true);
  assert.equal(plan.stages[1]?.automated, true);
  assert.equal(plan.stages[2]?.automated, false);
  assert.equal("command" in (plan.stages[0] ?? {}), false);
  assert.equal("timeout_seconds" in (plan.stages[1] ?? {}), false);
});

test("background_task status without task_id returns the latest completed task when nothing is active", async () => {
  const { handler } = fixture();
  const started = await handler({
    action: "start",
    workspace_id: "ws_1",
    prompt: "Finish me.",
  });
  const taskId = String(started.structuredContent.task_id);
  await handler({
    action: "complete",
    workspace_id: "ws_1",
    task_id: taskId,
    prompt: "Done.",
  });

  const recovered = await handler({
    action: "status",
    workspace_id: "ws_new",
    include_response: true,
  });
  assert.equal(recovered.structuredContent.task_id, taskId);
  assert.equal(recovered.structuredContent.status, "completed");
  assert.equal(recovered.structuredContent.response, "Done.");
  assert.match(String(recovered.structuredContent.result), /already completed/);
});
