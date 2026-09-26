import * as z from "zod/v4";
import type { HostTaskRecord } from "../flyto2/host-tasks.js";
import {
  toolNames,
  workspaceIdDescription,
  type ToolRegistrationContext,
} from "./types.js";
import { resultOutputSchema, textBlock } from "./shared.js";

const DEFAULT_RESPONSE_PREVIEW_CHARS = 8_000;
const CODEX_RESPONSE_PREVIEW_CHARS = 3_000;

const BACKGROUND_TASK_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

export function registerBackgroundTaskTool(context: ToolRegistrationContext): void {
  context.server.registerTool(
    toolNames.backgroundTask,
    {
      title: "Persist durable ChatGPT task",
      description:
        "Persist ChatGPT-owned task state across reconnects. Runtime stores checkpoints only and never delegates to another model.",
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
        include_response: z
          .boolean()
          .optional()
          .describe("Include stored task text. Defaults false."),
      },
      outputSchema: resultOutputSchema({
        task_id: z.string().optional(),
        status: z.enum(["running", "completed", "failed", "stopped"]),
        original_prompt: z.string().optional(),
        checkpoint: z.string().optional(),
        response: z.string().optional(),
      }),
      annotations: BACKGROUND_TASK_ANNOTATIONS,
    },
    async ({ action, workspace_id, task_id, prompt, include_response }) => {
      const workspace = await context.workspaces.getWorkspace(workspace_id);
      const previewChars = context.config.toolMode === "codex"
        ? CODEX_RESPONSE_PREVIEW_CHARS
        : DEFAULT_RESPONSE_PREVIEW_CHARS;

      if (action === "start") {
        if (!prompt) return invalidInput("prompt is required for action=start.");
        const record = context.hostTasks.create({
          workspaceId: workspace_id,
          workspaceRoot: workspace.root,
          prompt,
        });
        return recordResult(
          record,
          include_response === true,
          previewChars,
          `Durable task ${record.id} is recorded for ChatGPT. Continue the work with the normal workspace tools. Runtime will preserve this task state across reconnects and will not start another model or local-agent provider.`,
        );
      }

      if (!task_id) {
        if (action !== "status") return invalidInput(`task_id is required for action=${action}.`);
        const recoverable = context.hostTasks.findLatestActiveByRoot(workspace.root);
        if (!recoverable) {
          return failedResult(`No active durable task was found for ${workspace.root}.`);
        }
        const recovered = adoptTask(context, recoverable, workspace_id, workspace.root);
        if ("error" in recovered) return failedResult(recovered.error, recoverable.id);
        return recordResult(
          recovered,
          include_response === true,
          previewChars,
          `Recovered durable task ${recovered.id} for this repo from a previous ChatGPT workspace. ChatGPT can resume from the stored checkpoint with normal workspace tools.`,
        );
      }

      const current = scopedTask(context, task_id, workspace_id, workspace.root);
      if ("error" in current) return failedResult(current.error, task_id);

      if (action === "status" || action === "wait") {
        const message = current.status === "active"
          ? action === "wait"
            ? `Durable task ${current.id} is still active. There is no background model to wait for; ChatGPT should resume it with normal workspace tools.`
            : `Durable task ${current.id} is active and ready for ChatGPT to resume.`
          : undefined;
        return recordResult(current, include_response === true, previewChars, message);
      }

      if (action === "continue") {
        if (!prompt) return invalidInput("prompt is required for action=continue.");
        if (current.status !== "active") {
          return failedResult(`Durable task ${current.id} is already ${current.status}.`, current.id);
        }
        const updated = context.hostTasks.checkpoint(current.id, prompt);
        if (!updated) return failedResult(`Durable task ${current.id} no longer exists.`, current.id);
        return recordResult(
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
        return recordResult(
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
      return recordResult(
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
): HostTaskRecord | { error: string } {
  const record = context.hostTasks.get(taskId);
  if (!record) return { error: `Durable task ${taskId} was not found.` };
  if (record.workspaceRoot !== workspaceRoot) {
    return { error: `Durable task ${taskId} does not belong to this workspace.` };
  }
  return adoptTask(context, record, workspaceId, workspaceRoot);
}

function adoptTask(
  context: ToolRegistrationContext,
  record: HostTaskRecord,
  workspaceId: string,
  workspaceRoot: string,
): HostTaskRecord | { error: string } {
  if (record.workspaceRoot !== workspaceRoot) {
    return { error: `Durable task ${record.id} does not belong to this workspace.` };
  }
  if (record.workspaceId === workspaceId || record.status !== "active") return record;

  const adopted = context.hostTasks.adoptActive(record.id, workspaceId, workspaceRoot);
  if (!adopted || adopted.workspaceId !== workspaceId) {
    return { error: `Durable task ${record.id} could not be recovered into this workspace.` };
  }
  return adopted;
}

function recordResult(
  record: HostTaskRecord,
  includeResponse: boolean,
  previewChars: number,
  message?: string,
) {
  const status = recordStatus(record);
  const originalPrompt = includeResponse ? responsePreview(record.prompt, previewChars) : undefined;
  const checkpoint = includeResponse ? responsePreview(record.checkpoint, previewChars) : undefined;
  const response = includeResponse ? responsePreview(record.result, previewChars) : undefined;
  const result = message
    ?? (status === "completed"
      ? `Durable task ${record.id} completed.`
      : status === "stopped"
        ? `Durable task ${record.id} stopped.`
        : `Durable task ${record.id} is active and ready for ChatGPT to resume.`);

  return toolResult({
    result,
    task_id: record.id,
    status,
    original_prompt: originalPrompt,
    checkpoint,
    response,
  });
}

function recordStatus(record: HostTaskRecord): BackgroundTaskStatus {
  if (record.status === "completed") return "completed";
  if (record.status === "stopped") return "stopped";
  return "running";
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
  }, true);
}

function toolResult(
  structuredContent: {
    result: string;
    task_id?: string;
    status: BackgroundTaskStatus;
    original_prompt?: string;
    checkpoint?: string;
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
