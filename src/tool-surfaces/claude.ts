import * as z from "zod/v4";
import {
  editFileTool,
  writeFileTool,
} from "../pi-tools.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolInstructionContext,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  countDiffStats,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
} from "./shared.js";
import { registerBackgroundTaskTool } from "./background-task.js";

const CLAUDE_INSTRUCTIONS = `Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`;

export function claudeInstructions({
  agents,
  skills,
}: ToolInstructionContext): string {
  return `${agents}${skills}${CLAUDE_INSTRUCTIONS}`;
}

export function registerClaudeTools(context: ToolRegistrationContext): void {
  registerBackgroundTaskTool(context);
  registerClaudeMutationTools(context);
  registerShellTool(context);
}

const LEGACY_BASH_YIELD_MS = 750;
const LEGACY_BASH_RESUME_WAIT_MS = 1_500;
const LEGACY_BASH_EVENT_TYPE = "legacy_bash.exited";
const LEGACY_JOB_COMMAND_PREFIX = "@flyto2/job";
const CLAUDE_SHELL_DESCRIPTION =
  "Run a shell command in a workspace with the user's local permissions. Short commands return normally. Commands still running after a brief yield window continue as durable Flyto2 Runtime jobs and return immediately with a job_id instead of blocking the host. Follow the returned @flyto2/job command to inspect a legacy job later; never rerun the original side effect just because its first response was lost or still running.";

const CLAUDE_EDIT_INPUT_SCHEMA = {
  workspace_id: z.string().describe(workspaceIdDescription),
  path: z
    .string()
    .describe("File path to edit, relative to the workspace root."),
  edits: z
    .array(
      z.object({
        old_text: z
          .string()
          .describe(
            "Exact text to replace. Must match uniquely in the original file.",
          ),
        new_text: z.string().describe("Replacement text."),
      }),
    )
    .min(1),
};

const CLAUDE_EDIT_OUTPUT_SCHEMA = resultOutputSchema({
  status: z.literal("applied"),
});

interface ClaudeWriteInput {
  workspace_id: string;
  path: string;
  content: string;
}

interface ClaudeEditInput {
  workspace_id: string;
  path: string;
  edits: Array<{ old_text: string; new_text: string }>;
}

function registerClaudeMutationTools(context: ToolRegistrationContext): void {
  registerClaudeWriteTool(context);
  registerClaudeEditTool(context);
}

function registerClaudeWriteTool(context: ToolRegistrationContext): void {
  context.server.registerTool(
    toolNames.write,
    {
      title: "Write file",
      description: "Create or completely overwrite a file in a workspace.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async (input) => handleClaudeWrite(context, input),
  );
}

async function handleClaudeWrite(
  context: ToolRegistrationContext,
  input: ClaudeWriteInput,
) {
  const { config, workspaces } = context;
  const startedAt = performance.now();
  const workspaceId = input.workspace_id;
  const workspace = await workspaces.getWorkspace(workspaceId);
  const path = await workspaces.resolvePath(workspace, input.path);
  const response = await writeFileTool(
    { path, content: input.content },
    { cwd: workspace.root },
  );

  if (response.isError) {
    logFailedToolResponse(
      config,
      {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
      },
      response.content,
      startedAt,
    );
    return response;
  }

  logToolCall(config, {
    tool: toolNames.write,
    workspaceId,
    path: input.path,
    success: true,
    durationMs: Math.round(performance.now() - startedAt),
  });

  return {
    ...response,
    structuredContent: {
      result: contentText(response.content),
    },
  };
}

function registerClaudeEditTool(context: ToolRegistrationContext): void {
  context.server.registerTool(
    toolNames.edit,
    {
      title: "Edit file",
      description:
        "Edit one file in a workspace by replacing exact text blocks. Each old_text must match a unique, non-overlapping region of the original file.",
      inputSchema: CLAUDE_EDIT_INPUT_SCHEMA,
      outputSchema: CLAUDE_EDIT_OUTPUT_SCHEMA,
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async (input) => handleClaudeEdit(context, input),
  );
}

async function handleClaudeEdit(
  context: ToolRegistrationContext,
  input: ClaudeEditInput,
) {
  const { config, workspaces } = context;
  const startedAt = performance.now();
  const workspaceId = input.workspace_id;
  const workspace = await workspaces.getWorkspace(workspaceId);
  const path = await workspaces.resolvePath(workspace, input.path);
  const response = await editFileTool({
    path,
    edits: input.edits.map(({ old_text, new_text }) => ({
      oldText: old_text,
      newText: new_text,
    })),
  }, { cwd: workspace.root });

  if (response.isError) {
    logFailedToolResponse(
      config,
      {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
      },
      response.content,
      startedAt,
    );
    return response;
  }

  const stats = countDiffStats(
    response.details?.patch ?? response.details?.diff,
  );
  const editResultText =
    "Edited " + input.path + " (+" + stats.additions + " -" + stats.removals + ").";
  const editContent = [textBlock(editResultText)];
  logToolCall(config, {
    tool: toolNames.edit,
    workspaceId,
    path: input.path,
    success: true,
    durationMs: Math.round(performance.now() - startedAt),
  });

  return {
    content: editContent,
    structuredContent: {
      status: "applied",
      result: contentText(editContent),
    },
  };
}

function registerShellTool(context: ToolRegistrationContext): void {
  const {
    server,
    config,
    workspaces,
    runtimeEvents,
    reactiveCommands,
  } = context;

  server.registerTool(
    toolNames.shell,
    {
      title: "Bash",
      description: CLAUDE_SHELL_DESCRIPTION,
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        command: z
          .string()
          .describe(
            `Shell command to execute. If a prior call returned a Flyto2 Runtime job receipt, inspect it later with the exact command "${LEGACY_JOB_COMMAND_PREFIX} <job_id>" instead of rerunning the original command.`,
          ),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, working_directory, ...input }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workingDirectory = working_directory;
      const existingJobId = legacyJobIdFromCommand(input.command);
      let response;
      let responseJobStatus: "running" | "completed" | "failed" | "orphaned" | undefined;
      let jobId: string | undefined;

      if (existingJobId) {
        jobId = existingJobId;
        const outcome = await legacyJobResponse(
          context,
          workspaceId,
          existingJobId,
          LEGACY_BASH_RESUME_WAIT_MS,
        );
        response = outcome.response;
        responseJobStatus = outcome.status;
      } else {
        const workspace = await workspaces.getWorkspace(workspaceId);
        const cwd = await workspaces.resolveWorkingDirectory(
          workspace,
          workingDirectory,
        );
        const receipt = reactiveCommands.start({
          workspace_id: workspaceId,
          workspace_root: workspace.root,
          command: input.command,
          cwd,
          event_type: LEGACY_BASH_EVENT_TYPE,
          timeout_seconds: input.timeout ?? 30,
        });
        jobId = receipt.job_id;
        const outcome = await legacyJobResponse(
          context,
          workspaceId,
          receipt.job_id,
          LEGACY_BASH_YIELD_MS,
        );
        response = outcome.response;
        responseJobStatus = outcome.status;
      }

      const running = responseJobStatus === "running";
      if (
        !existingJobId
        && jobId
        && responseJobStatus !== undefined
        && responseJobStatus !== "running"
      ) {
        reactiveCommands.discardTerminal(jobId);
      }
      const logFields = {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        jobId,
        running,
      };

      if (response.isError) {
        logFailedToolResponse(
          config,
          logFields,
          response.content,
          startedAt,
        );
        return response;
      }

      logToolCall(config, {
        ...logFields,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return response;
    },
  );
}

function legacyJobIdFromCommand(command: string): string | undefined {
  const match = new RegExp(
    `^${LEGACY_JOB_COMMAND_PREFIX.replace("/", "\\/")}\\s+(job_[A-Za-z0-9]+)\\s*$`,
  ).exec(command.trim());
  return match?.[1];
}

async function legacyJobResponse(
  context: ToolRegistrationContext,
  workspaceId: string,
  jobId: string,
  waitMs: number,
) {
  const { runtimeEvents, reactiveCommands } = context;
  let job = reactiveCommands.get(jobId);
  if (!job || job.workspace_id !== workspaceId) {
    return {
      response: shellResponse(
        `Unknown Flyto2 Runtime job ${jobId} for workspace ${workspaceId}.`,
        true,
      ),
      status: undefined,
    };
  }

  if (job.status === "running" && waitMs > 0) {
    await runtimeEvents.wait({
      workspace_id: workspaceId,
      correlation_id: jobId,
      type: job.event_type,
      timeout_ms: waitMs,
    });
    job = reactiveCommands.get(jobId) ?? job;
  }

  const evidence = reactiveCommands.readEvidence(job.evidence_ref, 12_000);
  const output = evidence.text.trimEnd();

  if (job.status === "completed") {
    return {
      response: shellResponse(
        output || "Command completed successfully with no output.",
        false,
      ),
      status: job.status,
    };
  }

  if (job.status === "failed") {
    const outcome = job.exit_code !== undefined
      ? `exit code ${job.exit_code}`
      : job.signal
        ? `signal ${job.signal}`
        : "an unsuccessful exit";
    return {
      response: shellResponse(
        `Command failed with ${outcome}.${output ? `\n${output}` : ""}`,
        true,
      ),
      status: job.status,
    };
  }

  if (job.status === "orphaned") {
    return {
      response: shellResponse(
        [
          `Flyto2 Runtime job ${jobId} was interrupted by a Runtime restart and its final outcome is uncertain.`,
          "Do not automatically rerun the original side effect. Inspect the workspace/evidence first, then decide whether a retry is safe.",
          output ? `Evidence captured before interruption:\n${output}` : "",
        ].filter(Boolean).join("\n"),
        true,
      ),
      status: job.status,
    };
  }

  return {
    response: shellResponse(
      [
        `Command is still running as Flyto2 Runtime job ${jobId}.`,
        "Do not rerun the original command. Continue other useful work instead of waiting on this MCP request.",
        `Check it later with this same bash tool using command exactly: ${LEGACY_JOB_COMMAND_PREFIX} ${jobId}`,
        `Evidence reference: ${job.evidence_ref}`,
        output ? `Output so far:\n${output}` : "",
      ].filter(Boolean).join("\n"),
      false,
    ),
    status: job.status,
  };
}

function shellResponse(result: string, isError: boolean) {
  const content = [textBlock(result)];
  return {
    content,
    ...(isError ? { isError: true } : {}),
    structuredContent: { result: contentText(content) },
  };
}
