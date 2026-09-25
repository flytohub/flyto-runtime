import * as z from "zod/v4";
import type { LocalAgentWaitResult } from "../local-agent-manager.js";
import type { LocalAgentRecord } from "../local-agent-store.js";
import {
  toolNames,
  workspaceIdDescription,
  type ToolRegistrationContext,
} from "./types.js";
import { resultOutputSchema, textBlock } from "./shared.js";

const DEFAULT_WAIT_MS = 25_000;
const MAX_WAIT_SECONDS = 50;
const RESPONSE_PREVIEW_CHARS = 8_000;

const BACKGROUND_TASK_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

export function registerBackgroundTaskTool(context: ToolRegistrationContext): void {
  if (!context.config.subagents.enabled) return;

  context.server.registerTool(
    toolNames.backgroundTask,
    {
      title: "Run durable background task",
      description:
        "Start or resume a complete multi-step coding task owned by Flyto2 Runtime's detached local-agent daemon. Use this when work must continue after the current ChatGPT turn, page, or MCP connection ends. The background task may inspect files, edit, test, and finish autonomously inside the workspace. Use status or wait later with its task_id. Responses stay compact unless include_response=true. Do not use this for one simple read or shell command.",
      inputSchema: {
        action: z.enum(["start", "status", "wait", "continue"]),
        workspace_id: z.string().describe(workspaceIdDescription),
        task_id: z
          .string()
          .optional()
          .describe("Task id returned by start. Required for status, wait, and continue."),
        prompt: z
          .string()
          .min(1)
          .optional()
          .describe("Complete task for start, or follow-up instructions for continue."),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe("Maximum wait time for action=wait. Defaults to 25 seconds."),
        include_response: z
          .boolean()
          .optional()
          .describe("Include the final agent response when completed. Defaults to false to keep the conversation small."),
      },
      outputSchema: resultOutputSchema({
        task_id: z.string().optional(),
        status: z.enum(["running", "completed", "failed", "stopped"]),
        provider: z.string().optional(),
        response: z.string().optional(),
        error: z.string().optional(),
        retry_after_ms: z.number().int().nonnegative().optional(),
      }),
      annotations: BACKGROUND_TASK_ANNOTATIONS,
    },
    async ({ action, workspace_id, task_id, prompt, timeout_seconds, include_response }) => {
      const workspace = await context.workspaces.getWorkspace(workspace_id);
      const scope = { workspaceId: workspace_id, workspaceRoot: workspace.root };

      if (action === "start") {
        if (!prompt) return invalidInput("prompt is required for action=start.");
        const provider = context.resolveLocalAgentProviders().find((entry) => entry.usable);
        if (!provider) {
          return failedResult(
            "No enabled local-agent provider is available. Run Flyto2 Runtime setup and enable Claude, Codex, or another supported provider.",
          );
        }
        const started = await context.localAgents.start({
          target: provider.id,
          prompt: durableTaskPrompt(prompt),
          workspaceId: workspace_id,
          workspaceRoot: workspace.root,
          writeMode: "allowed",
        });
        if (started.isErr()) return clientError(started.error);
        return recordResult(started.value, false);
      }

      if (!task_id) return invalidInput(`task_id is required for action=${action}.`);

      if (action === "continue") {
        if (!prompt) return invalidInput("prompt is required for action=continue.");
        const continued = await context.localAgents.continue(
          task_id,
          durableTaskPrompt(prompt),
          { writeMode: "allowed" },
          scope,
        );
        if (continued.isErr()) return clientError(continued.error, task_id);
        return recordResult(continued.value, false);
      }

      if (action === "wait") {
        const waited = await context.localAgents.wait(
          [task_id],
          scope,
          (timeout_seconds ?? DEFAULT_WAIT_MS / 1_000) * 1_000,
        );
        if (waited.isErr()) return clientError(waited.error, task_id);
        return waitResult(waited.value[0], task_id, include_response === true);
      }

      const current = await context.localAgents.get(task_id, scope);
      if (current.isErr()) return clientError(current.error, task_id);
      return recordResult(current.value, include_response === true);
    },
  );
}

function durableTaskPrompt(prompt: string): string {
  return [
    "Own this task through completion even if the caller disconnects.",
    "Work autonomously within the requested scope, follow repository instructions, and preserve unrelated changes.",
    "For coding tasks that require file changes: inspect the current Git state, implement the requested change, run appropriate verification, then create a focused commit containing only your task changes unless the caller explicitly requested no commit or repository instructions forbid committing.",
    "Do not push, publish, deploy, open a pull request, or absorb unrelated pre-existing changes unless the original task explicitly authorizes it.",
    "Do not pause merely because the caller is unavailable. Stop only when the task is complete or genuinely requires credentials, authorization, or a user decision.",
    "In the final response, report the outcome, verification performed, and the commit SHA when a commit was created; otherwise state why no commit was needed or possible.",
    "",
    prompt,
  ].join("\n");
}

function recordResult(record: LocalAgentRecord, includeResponse: boolean) {
  const status = recordStatus(record);
  const response = includeResponse ? responsePreview(record.latestResponse) : undefined;
  const result = status === "running"
    ? `Background task ${record.id} is running independently. It will continue if this conversation disconnects.`
    : status === "completed"
      ? `Background task ${record.id} completed.${includeResponse ? "" : " Request status with include_response=true only if its final response is needed."}`
      : status === "failed"
        ? `Background task ${record.id} failed: ${record.error ?? "unknown error"}`
        : `Background task ${record.id} stopped.`;
  return toolResult({
    result,
    task_id: record.id,
    status,
    provider: record.provider,
    response,
    error: record.error,
    retry_after_ms: status === "running" ? 5_000 : undefined,
  }, status === "failed");
}

function waitResult(
  waited: LocalAgentWaitResult | undefined,
  taskId: string,
  includeResponse: boolean,
) {
  if (!waited) return failedResult("Background task returned no wait result.", taskId);
  if (waited.status === "running") {
    return toolResult({
      result: `Background task ${taskId} is still running independently.`,
      task_id: taskId,
      status: "running" as const,
      retry_after_ms: 5_000,
    });
  }
  if (waited.status === "completed") {
    const response = includeResponse ? responsePreview(waited.response) : undefined;
    return toolResult({
      result: `Background task ${taskId} completed.${includeResponse ? "" : " Request status with include_response=true only if its final response is needed."}`,
      task_id: taskId,
      status: "completed" as const,
      response,
    });
  }
  const error = waited.error?.message;
  return toolResult({
    result: waited.status === "failed"
      ? `Background task ${taskId} failed: ${error ?? "unknown error"}`
      : `Background task ${taskId} stopped${error ? `: ${error}` : "."}`,
    task_id: taskId,
    status: waited.status,
    error,
  }, waited.status === "failed");
}

function recordStatus(record: LocalAgentRecord): BackgroundTaskStatus {
  if (record.status === "idle") return "completed";
  if (record.status === "error") return "failed";
  if (record.status === "stopped") return "stopped";
  return "running";
}

function responsePreview(response: string | undefined): string | undefined {
  if (!response) return undefined;
  if (response.length <= RESPONSE_PREVIEW_CHARS) return response;
  return `${response.slice(0, RESPONSE_PREVIEW_CHARS)}\n[Response truncated; full response remains in Runtime state.]`;
}

function invalidInput(message: string) {
  return failedResult(message);
}

function clientError(error: unknown, taskId?: string) {
  const value = error as { message?: string };
  return failedResult(value.message ?? String(error), taskId);
}

function failedResult(error: string, taskId?: string) {
  return toolResult({
    result: error,
    task_id: taskId,
    status: "failed" as const,
    error,
  }, true);
}

function toolResult(
  structuredContent: {
    result: string;
    task_id?: string;
    status: BackgroundTaskStatus;
    provider?: string;
    response?: string;
    error?: string;
    retry_after_ms?: number;
  },
  isError = false,
) {
  return {
    content: [textBlock(structuredContent.result)],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}
