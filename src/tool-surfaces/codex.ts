import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { applyPatch } from "../apply-patch.js";
import {
  MAX_PROCESS_YIELD_MS,
  type ProcessSnapshot,
} from "../process-sessions.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolLogFields,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

type CodexSessionId = string;

interface CodexProcessSnapshot extends Omit<ProcessSnapshot, "sessionId"> {
  sessionId?: CodexSessionId;
}

const CODEX_DURABLE_EVENT_TYPE = "codex.exec.exited";
const CODEX_DURABLE_SESSION_PREFIX = "proc_";
const DEFAULT_CODEX_YIELD_MS = 3_000;
const DEFAULT_CODEX_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_CODEX_POLL_YIELD_MS = 5_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const CODEX_UNCERTAIN_OUTCOME_SIGNAL = "OUTCOME_UNCERTAIN";

const CODEX_INSTRUCTIONS = `Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) {
    register(context);
  }
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerCodexProcessTools,
];

function processResult(snapshot: CodexProcessSnapshot): string {
  const status = snapshot.running
    ? `Process is still running with session_id=${snapshot.sessionId}. Continue it with write_stdin.`
    : snapshot.signal === CODEX_UNCERTAIN_OUTCOME_SIGNAL
      ? "Process outcome is uncertain. Do not rerun the command blindly."
      : snapshot.signal
        ? `Process exited after signal ${snapshot.signal}.`
        : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}`
    : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    session_id: z.string().optional(),
    running: z.boolean(),
    exit_code: z.number().int().optional(),
    signal: z.string().optional(),
    wall_time_ms: z.number().nonnegative(),
    output_truncated: z.boolean(),
  });
}

function processToolResponse(snapshot: CodexProcessSnapshot) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      result,
      session_id: snapshot.sessionId,
      running: snapshot.running,
      exit_code: snapshot.exitCode,
      signal: snapshot.signal,
      wall_time_ms: snapshot.wallTimeMs,
      output_truncated: snapshot.outputTruncated,
    },
  };
}

function newCodexProcessSessionId(): string {
  return `${CODEX_DURABLE_SESSION_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

function codexSessionIdForReactiveJob(jobId: string): string {
  const match = /^job_([a-f0-9]{32})$/.exec(jobId);
  if (!match) throw new Error("Runtime returned an invalid process session identifier.");
  return `${CODEX_DURABLE_SESSION_PREFIX}${match[1]}`;
}

function codexInteractiveSnapshot(
  snapshot: ProcessSnapshot,
  exposedSessionId?: string,
): CodexProcessSnapshot {
  const { sessionId: internalSessionId, ...rest } = snapshot;
  return {
    ...rest,
    sessionId: snapshot.running && internalSessionId !== undefined
      ? exposedSessionId
      : undefined,
  };
}

function reactiveJobIdFromCodexSession(sessionId: string): string {
  const opaque = /^proc_([a-f0-9]{32})$/.exec(sessionId);
  if (opaque) return `job_${opaque[1]}`;

  // Accept sessions issued by older Codex-mode Runtime builds across an upgrade,
  // but never emit the internal job identifier on the model-facing surface.
  if (/^job_[a-f0-9]{32}$/.test(sessionId)) return sessionId;
  throw new Error("Unknown process session identifier.");
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style patch to add, overwrite, update, delete, or move workspace files. Paths must be relative to the workspace.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        patch: z
          .string()
          .describe(
            "Patch text enclosed by *** Begin Patch and *** End Patch markers.",
          ),
      },
      outputSchema: resultOutputSchema({
        additions: z.number(),
        removals: z.number(),
        files: z.array(
          z.object({
            path: z.string(),
            previous_path: z.string().optional(),
            operation: z.enum(["add", "update", "delete", "move"]),
          }),
        ),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, patch }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return applyPatch(workspace.root, patch);
        },
      );
      const paths = applied.files.map((file) => file.path).join(", ");
      const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
      const content = [textBlock(result)];

      return {
        content,
        structuredContent: {
          result,
          additions: applied.additions,
          removals: applied.removals,
          files: applied.files.map(({ previousPath, ...file }) => ({
            ...file,
            previous_path: previousPath,
          })),
        },
      };
    },
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const {
    server,
    config,
    workspaces,
    processSessions,
    reactiveCommands,
  } = context;
  const interactiveSessions = new Map<string, number>();

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command in a workspace with the user's local permissions. If the result is still running, continue its session_id with write_stdin instead of running the command again. Set tty=true only for input-driven interactive commands.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe(
            "Allocate a pseudo-terminal for interactive commands. Defaults to false.",
          ),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .max(3_600)
          .optional()
          .describe(
            "Optional hard timeout for a non-interactive command. Maximum 3600 seconds.",
          ),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      cmd,
      tty,
      working_directory,
      timeout_seconds,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workingDirectory = working_directory;
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
        },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          const cwd = await workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          if (tty) {
            const process = await processSessions.start({
              workspaceId,
              command: cmd,
              cwd,
              workspaceRoot: workspace.root,
              tty: true,
              yieldTimeMs: DEFAULT_CODEX_INTERACTIVE_YIELD_MS,
            });
            if (!process.running || process.sessionId === undefined) {
              return codexInteractiveSnapshot(process);
            }
            const exposedSessionId = newCodexProcessSessionId();
            interactiveSessions.set(exposedSessionId, process.sessionId);
            return codexInteractiveSnapshot(process, exposedSessionId);
          }

          const receipt = reactiveCommands.start({
            workspace_id: workspaceId,
            workspace_root: workspace.root,
            command: cmd,
            cwd,
            event_type: CODEX_DURABLE_EVENT_TYPE,
            timeout_seconds,
          });
          const durableSnapshot = await durableProcessSnapshot(
            context,
            workspaceId,
            receipt.job_id,
            DEFAULT_CODEX_YIELD_MS,
            DEFAULT_MAX_OUTPUT_TOKENS,
          );
          if (!durableSnapshot.running) {
            reactiveCommands.discardTerminal(receipt.job_id);
          }
          return durableSnapshot;
        },
        processLogFields,
      );

      return processToolResponse(snapshot);
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Continue process",
      description:
        "Continue a session returned by exec_command. Omit chars to wait for completion. Interactive sessions accept input; \\u0003 interrupts or cancels the process. Do not rerun the original command while its session is still available.",
      inputSchema: {
        workspace_id: z
          .string()
          .describe("Workspace identifier used to start the process."),
        session_id: z
          .string()
          .min(1)
          .max(128)
          .describe("Opaque process session identifier returned by exec_command."),
        chars: z
          .string()
          .optional()
          .describe(
            "Input for an interactive session. Omit to wait for completion; use \\u0003 to interrupt or cancel.",
          ),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      session_id,
      chars,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const sessionId = session_id;
      const snapshot = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          const interactiveSessionId = interactiveSessions.get(sessionId);
          if (interactiveSessionId !== undefined) {
            const process = await processSessions.write({
              workspaceId,
              sessionId: interactiveSessionId,
              chars,
            });
            if (!process.running) interactiveSessions.delete(sessionId);
            return codexInteractiveSnapshot(process, sessionId);
          }

          const jobId = reactiveJobIdFromCodexSession(sessionId);
          if (chars && chars !== "\u0003") {
            throw new Error(
              "This process session does not accept stdin. Start exec_command with tty=true for an input-driven process.",
            );
          }
          if (chars === "\u0003") {
            reactiveCommands.signal(jobId, workspaceId, "SIGINT");
          }
          return durableProcessSnapshot(
            context,
            workspaceId,
            jobId,
            DEFAULT_CODEX_POLL_YIELD_MS,
            DEFAULT_MAX_OUTPUT_TOKENS,
          );
        },
        processLogFields,
      );

      return processToolResponse(snapshot);
    },
  );
}

async function durableProcessSnapshot(
  context: ToolRegistrationContext,
  workspaceId: string,
  jobId: string,
  yieldTimeMs: number,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
): Promise<CodexProcessSnapshot> {
  const { runtimeEvents, reactiveCommands } = context;
  let job = reactiveCommands.get(jobId);
  if (!job || job.workspace_id !== workspaceId) {
    throw new Error(`Unknown process session for workspace ${workspaceId}.`);
  }

  if (job.status === "running" && yieldTimeMs > 0) {
    await runtimeEvents.wait({
      after_sequence: 0,
      workspace_id: workspaceId,
      type: job.event_type,
      correlation_id: jobId,
      timeout_ms: Math.min(MAX_PROCESS_YIELD_MS, Math.max(0, yieldTimeMs)),
    });
    job = reactiveCommands.get(jobId) ?? job;
  }

  const wallTimeMs = Math.max(
    0,
    Date.parse(job.completed_at ?? new Date().toISOString())
      - Date.parse(job.started_at),
  );
  if (job.status === "running") {
    return {
      sessionId: codexSessionIdForReactiveJob(jobId),
      output: "",
      outputTruncated: false,
      running: true,
      wallTimeMs,
    };
  }

  const maxCharacters = Math.max(
    256,
    Math.min(256_000, Math.floor(maxOutputTokens) * 4),
  );
  const evidence = reactiveCommands.readEvidence(job.evidence_ref, maxCharacters);
  const orphaned = job.status === "orphaned";

  return {
    output: evidence.text,
    outputTruncated: evidence.truncated,
    running: false,
    exitCode: job.exit_code,
    signal: orphaned ? CODEX_UNCERTAIN_OUTCOME_SIGNAL : job.signal,
    wallTimeMs,
  };
}

export function processLogFields(result: CodexProcessSnapshot): Partial<ToolLogFields> {
  const success = result.running || (!result.signal && result.exitCode === 0);
  const termination = result.signal
    ? `Process terminated by signal ${result.signal}.`
    : `Process exited with code ${result.exitCode ?? "unknown"}.`;
  return {
    sessionId: result.sessionId,
    running: result.running,
    exitCode: result.exitCode,
    success,
    ...(success ? {} : { error: termination }),
  };
}
