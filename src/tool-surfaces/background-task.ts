import * as z from "zod/v4";
import type {
  HostTaskExecutionState,
  HostTaskPlan,
  HostTaskPlanStageStatus,
  HostTaskRecord,
  HostTaskStatus,
} from "../flyto2/host-tasks.js";
import { hostTaskExecutionState } from "../flyto2/host-tasks.js";
import {
  buildTaskDiagnosis,
  type TaskDiagnosis,
} from "../flyto2/task-diagnostics.js";
import {
  toolNames,
  workspaceIdDescription,
  type ToolRegistrationContext,
} from "./types.js";
import { resultOutputSchema, textBlock } from "./shared.js";

const DEFAULT_RESPONSE_PREVIEW_CHARS = 8_000;
const CODEX_RESPONSE_PREVIEW_CHARS = 3_000;
const MAX_PLAN_STAGES = 10;
const MAX_STAGE_TITLE_CHARS = 80;
const MAX_STAGE_SUMMARY_CHARS = 240;

const planStageInputSchema = z.union([
  z.string().min(1).max(MAX_STAGE_TITLE_CHARS),
  z.object({
    title: z.string().min(1).max(MAX_STAGE_TITLE_CHARS),
  }),
]);

const BACKGROUND_TASK_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

type BackgroundTaskStatus = HostTaskStatus | "failed";
type BackgroundTaskExecutionState = HostTaskExecutionState | "failed";

export function registerBackgroundTaskTool(context: ToolRegistrationContext): void {
  context.server.registerTool(
    toolNames.backgroundTask,
    {
      title: "Persist durable ChatGPT task",
      description:
        "Persist and recover ChatGPT-owned task state across reconnects. Optional plan stages are descriptive progress only. Runtime never executes stages and never delegates to another model.",
      inputSchema: {
        action: z.enum(["start", "status", "wait", "continue", "complete", "stop"]),
        workspace_id: z.string().describe(workspaceIdDescription),
        task_id: z
          .string()
          .optional()
          .describe("Task id; omit for start, or for status to recover the latest active task for this repo."),
        prompt: z
          .string()
          .min(1)
          .optional()
          .describe("Task text, checkpoint, final summary, or stop reason."),
        plan: z
          .array(planStageInputSchema)
          .min(1)
          .max(MAX_PLAN_STAGES)
          .optional()
          .describe("Optional 1-10 stage progress outline for recovery. Runtime stores it but never executes it."),
        current_stage: z
          .number()
          .int()
          .min(1)
          .max(MAX_PLAN_STAGES)
          .optional()
          .describe("1-based current plan stage for continue."),
        stage_status: z
          .enum(["pending", "running", "done", "blocked"])
          .optional()
          .describe("Status for current_stage. Defaults running when current_stage is supplied."),
        stage_summary: z
          .string()
          .max(MAX_STAGE_SUMMARY_CHARS)
          .optional()
          .describe("Short current-stage summary."),
        include_response: z
          .boolean()
          .optional()
          .describe("Include stored task text. Defaults false."),
      },
      outputSchema: resultOutputSchema({
        task_id: z.string().optional(),
        status: z.enum(["active", "completed", "failed", "stopped"]),
        execution_state: z.enum([
          "waiting_for_host",
          "needs_attention",
          "completed",
          "failed",
          "stopped",
        ]),
        workspace_id: z.string().optional(),
        workspace_root: z.string().optional(),
        repository_root: z.string().optional(),
        updated_at: z.string().optional(),
        plan: z.object({
          current_stage: z.number().int(),
          total_stages: z.number().int(),
          stages: z.array(z.object({
            index: z.number().int(),
            title: z.string(),
            status: z.enum(["pending", "running", "done", "blocked"]),
            summary: z.string().optional(),
          })),
        }).optional(),
        original_prompt: z.string().optional(),
        checkpoint: z.string().optional(),
        attention_reason: z.string().optional(),
        attention_at: z.string().optional(),
        diagnosis: z.record(z.string(), z.unknown()).optional(),
        response: z.string().optional(),
      }),
      annotations: BACKGROUND_TASK_ANNOTATIONS,
    },
    async ({
      action,
      workspace_id,
      task_id,
      prompt,
      plan,
      current_stage,
      stage_status,
      stage_summary,
      include_response,
    }) => {
      const workspace = await context.workspaces.getWorkspace(workspace_id);
      const repoRoot = workspace.sourceRoot ?? workspace.root;
      const previewChars = context.config.toolMode === "codex"
        ? CODEX_RESPONSE_PREVIEW_CHARS
        : DEFAULT_RESPONSE_PREVIEW_CHARS;

      if (action === "start") {
        if (!prompt) return invalidInput("prompt is required for action=start.");
        const record = context.hostTasks.create({
          workspaceId: workspace_id,
          repoRoot,
          workspaceRoot: workspace.root,
          prompt,
          plan: plan ? createPlan(plan) : undefined,
        });
        appendTaskLifecycleEvent(context, record, "task.started", "Durable task started.");
        return recordResult(
          context,
          record,
          include_response === true,
          previewChars,
          `Durable task ${record.id} is recorded for ChatGPT. Continue the work with the normal workspace tools. Runtime will preserve this task state across reconnects and will not start another model or local-agent provider.`,
        );
      }

      if (!task_id) {
        if (action !== "status") return invalidInput(`task_id is required for action=${action}.`);
        const recoverable = context.hostTasks.findLatestActiveByRepoRoot(repoRoot)
          ?? context.hostTasks.findLatestByRepoRoot(repoRoot);
        if (!recoverable) {
          return failedResult(`No durable task was found for repository ${repoRoot}.`);
        }
        const recovered = adoptTask(
          context,
          recoverable,
          workspace_id,
          workspace.root,
          repoRoot,
        );
        if ("error" in recovered) return failedResult(recovered.error, recoverable.id);
        const recoveryMessage = recovered.status === "active"
          ? `Recovered durable task ${recovered.id} for this repo from a previous ChatGPT workspace. ChatGPT can resume from the stored plan/checkpoint.`
          : `Recovered latest durable task ${recovered.id} for this repo; it is already ${recovered.status}.`;
        return recordResult(
          context,
          recovered,
          include_response === true,
          previewChars,
          recoveryMessage,
        );
      }

      const current = scopedTask(
        context,
        task_id,
        workspace_id,
        workspace.root,
        repoRoot,
      );
      if ("error" in current) return failedResult(current.error, task_id);

      if (action === "status" || action === "wait") {
        const message = current.status === "active"
          ? action === "wait"
            ? `Durable task ${current.id} is still active. There is no background model to wait for; ChatGPT should resume it with normal workspace tools.`
            : `Durable task ${current.id} is active and ready for ChatGPT to resume.`
          : undefined;
        return recordResult(context, current, include_response === true, previewChars, message);
      }

      if (action === "continue") {
        const hasPlanUpdate = current_stage !== undefined
          || stage_status !== undefined
          || stage_summary !== undefined;
        if (!prompt && !hasPlanUpdate) {
          return invalidInput("prompt or plan progress is required for action=continue.");
        }
        if (current.status !== "active") {
          return failedResult(`Durable task ${current.id} is already ${current.status}.`, current.id);
        }
        let updated = prompt ? context.hostTasks.checkpoint(current.id, prompt) : current;
        if (!updated) return failedResult(`Durable task ${current.id} no longer exists.`, current.id);
        if (hasPlanUpdate) {
          if (!updated.plan) {
            return failedResult(`Durable task ${current.id} has no persisted plan to update.`, current.id);
          }
          const stage = current_stage ?? updated.plan.currentStage;
          if (stage > updated.plan.stages.length) {
            return failedResult(
              `current_stage ${stage} exceeds this task's ${updated.plan.stages.length} plan stages.`,
              current.id,
            );
          }
          updated = context.hostTasks.updatePlan(current.id, {
            currentStage: current_stage,
            stageStatus: stage_status,
            stageSummary: stage_summary,
          });
          if (!updated) return failedResult(`Durable task ${current.id} no longer exists.`, current.id);
        }
        appendTaskLifecycleEvent(context, updated, "task.checkpointed", "Durable task checkpoint updated.");
        return recordResult(
          context,
          updated,
          include_response === true,
          previewChars,
          `Checkpoint saved for durable task ${updated.id}. ChatGPT remains the only task owner; continue with normal workspace tools.`,
        );
      }

      if (action === "complete") {
        if (current.status !== "active") {
          return failedResult(`Durable task ${current.id} is already ${current.status}.`, current.id);
        }
        const completed = context.hostTasks.complete(current.id, prompt);
        if (!completed) return failedResult(`Durable task ${current.id} no longer exists.`, current.id);
        appendTaskLifecycleEvent(context, completed, "task.completed", "Durable task completed.");
        return recordResult(
          context,
          completed,
          include_response === true,
          previewChars,
          `Durable task ${completed.id} completed by ChatGPT.`,
        );
      }

      if (current.status !== "active") {
        return failedResult(`Durable task ${current.id} is already ${current.status}.`, current.id);
      }
      const stopped = context.hostTasks.stop(current.id, prompt);
      if (!stopped) return failedResult(`Durable task ${current.id} no longer exists.`, current.id);
      appendTaskLifecycleEvent(context, stopped, "task.stopped", "Durable task stopped.");
      return recordResult(
        context,
        stopped,
        include_response === true,
        previewChars,
        `Durable task ${stopped.id} stopped.`,
      );
    },
  );
}

function scopedTask(
  context: ToolRegistrationContext,
  taskId: string,
  workspaceId: string,
  workspaceRoot: string,
  repoRoot: string,
): HostTaskRecord | { error: string } {
  const record = context.hostTasks.get(taskId);
  if (!record) return { error: `Durable task ${taskId} was not found.` };
  if (record.repoRoot !== repoRoot) {
    return { error: `Durable task ${taskId} does not belong to this repository.` };
  }
  return adoptTask(context, record, workspaceId, workspaceRoot, repoRoot);
}

function adoptTask(
  context: ToolRegistrationContext,
  record: HostTaskRecord,
  workspaceId: string,
  workspaceRoot: string,
  repoRoot: string,
): HostTaskRecord | { error: string } {
  if (record.repoRoot !== repoRoot) {
    return { error: `Durable task ${record.id} does not belong to this repository.` };
  }
  if (record.status !== "active") return record;
  if (record.workspaceId === workspaceId && record.workspaceRoot === workspaceRoot) return record;

  const adopted = context.hostTasks.adoptActive(
    record.id,
    workspaceId,
    workspaceRoot,
    repoRoot,
  );
  if (
    !adopted
    || adopted.workspaceId !== workspaceId
    || adopted.workspaceRoot !== workspaceRoot
  ) {
    return { error: `Durable task ${record.id} could not be recovered into this workspace.` };
  }
  return adopted;
}

function recordResult(
  context: ToolRegistrationContext,
  record: HostTaskRecord,
  includeResponse: boolean,
  previewChars: number,
  message?: string,
) {
  const status = recordStatus(record);
  const executionState = hostTaskExecutionState(record);
  const originalPrompt = includeResponse ? responsePreview(record.prompt, previewChars) : undefined;
  const checkpoint = includeResponse ? responsePreview(record.checkpoint, previewChars) : undefined;
  const response = includeResponse ? responsePreview(record.result, previewChars) : undefined;
  const diagnosis = context.runtimeEvents && context.reactiveCommands
    ? buildTaskDiagnosis(record, context.reactiveCommands, context.runtimeEvents)
    : undefined;
  const baseResult = message
    ?? (status === "completed"
      ? `Durable task ${record.id} completed.`
      : status === "stopped"
        ? `Durable task ${record.id} stopped.`
        : `Durable task ${record.id} is active and waiting for ChatGPT to resume.`);
  const result = appendPlanProgress(baseResult, record.plan);

  return toolResult({
    result,
    task_id: record.id,
    status,
    execution_state: executionState,
    workspace_id: record.workspaceId,
    workspace_root: record.workspaceRoot,
    repository_root: record.repoRoot,
    updated_at: record.updatedAt,
    plan: record.plan ? planOutput(record.plan) : undefined,
    original_prompt: originalPrompt,
    checkpoint,
    attention_reason: record.attentionReason,
    attention_at: record.attentionAt,
    diagnosis,
    response,
  });
}

function appendTaskLifecycleEvent(
  context: ToolRegistrationContext,
  record: HostTaskRecord,
  type: "task.started" | "task.checkpointed" | "task.completed" | "task.stopped",
  summary: string,
): void {
  try {
    context.runtimeEvents?.append({
      type,
      source: "background-task",
      workspace_id: record.workspaceId,
      correlation_id: record.id,
      correlations: {
        task_id: record.id,
        workspace_id: record.workspaceId,
      },
      summary,
      payload: {
        task_id: record.id,
        status: record.status,
        execution_state: hostTaskExecutionState(record),
        current_stage: record.plan?.currentStage,
        total_stages: record.plan?.stages.length,
      },
    });
  } catch {
    // Task persistence is authoritative; diagnostics are advisory.
  }
}

function createPlan(
  entries: Array<string | { title: string }>,
): HostTaskPlan {
  return {
    currentStage: 1,
    stages: entries.map((entry, index) => {
      const normalized = typeof entry === "string" ? { title: entry } : entry;
      return {
        title: normalized.title,
        status: index === 0 ? "running" : "pending",
      };
    }),
  };
}

function planOutput(plan: HostTaskPlan) {
  return {
    current_stage: plan.currentStage,
    total_stages: plan.stages.length,
    stages: plan.stages.map((stage, index) => ({
      index: index + 1,
      title: stage.title,
      status: stage.status,
      summary: stage.summary,
    })),
  };
}

function appendPlanProgress(message: string, plan: HostTaskPlan | undefined): string {
  if (!plan) return message;
  const current = plan.stages[plan.currentStage - 1];
  if (!current) return message;
  return `${message} Progress ${plan.currentStage}/${plan.stages.length}: ${current.title} (${current.status}).`;
}

function recordStatus(record: HostTaskRecord): BackgroundTaskStatus {
  return record.status;
}

function responsePreview(response: string | undefined, maxChars: number): string | undefined {
  if (!response) return undefined;
  if (response.length <= maxChars) return response;
  return `${response.slice(0, maxChars)}\n[Response truncated; full value remains in Runtime state.]`;
}

function invalidInput(message: string) {
  return failedResult(message);
}

function failedResult(error: string, taskId?: string) {
  return toolResult({
    result: error,
    task_id: taskId,
    status: "failed" as const,
    execution_state: "failed" as const,
  }, true);
}

function toolResult(
  structuredContent: {
    result: string;
    task_id?: string;
    status: BackgroundTaskStatus;
    execution_state: BackgroundTaskExecutionState;
    workspace_id?: string;
    workspace_root?: string;
    repository_root?: string;
    updated_at?: string;
    plan?: {
      current_stage: number;
      total_stages: number;
      stages: Array<{
        index: number;
        title: string;
        status: HostTaskPlanStageStatus;
        summary?: string;
      }>;
    };
    original_prompt?: string;
    checkpoint?: string;
    attention_reason?: string;
    attention_at?: string;
    diagnosis?: TaskDiagnosis;
    response?: string;
  },
  isError = false,
) {
  return {
    content: [textBlock(structuredContent.result)],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}
