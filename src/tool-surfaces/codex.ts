import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { applyPatch } from "../apply-patch.js";
import { LEGACY_JOB_COMMAND, LEGACY_SHELL_HEADER } from "../mcp-legacy-input.js";
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
import { registerBackgroundTaskTool } from "./background-task.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

type CodexSessionId = string;

interface CodexProcessSnapshot extends Omit<ProcessSnapshot, "sessionId"> {
  sessionId?: CodexSessionId;
  retryAfterMs?: number;
}

const CODEX_DURABLE_EVENT_TYPE = "codex.exec.exited";
const CODEX_DURABLE_SESSION_PREFIX = "proc_";
const DEFAULT_CODEX_YIELD_MS = 750;
const DEFAULT_CODEX_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_CODEX_POLL_YIELD_MS = 1_500;
const DEFAULT_CODEX_RETRY_AFTER_MS = 5_000;
const LEGACY_SHELL_WAIT_MS = 750;
const LEGACY_SHELL_POLL_WAIT_MS = 1_000;
// Tool output is copied into the host conversation. Keep the default small;
// full command evidence remains available in the durable Runtime job and a
// truncated result still preserves both the head and tail for diagnosis.
const DEFAULT_MAX_OUTPUT_TOKENS = 600;
const RUNNING_PROGRESS_PREVIEW_CHARS = 700;
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
  registerBackgroundTaskTool,
  registerApplyPatchTool,
  registerCodexProcessTools,
];

function processStatus(snapshot: CodexProcessSnapshot, legacyShell = false): string {
  const retryHint = snapshot.retryAfterMs
    ? ` Wait about ${Math.max(1, Math.round(snapshot.retryAfterMs / 1_000))}s before checking again; do not poll faster.`
    : "";
  return snapshot.running
    ? legacyShell
      ? `Still running (session ${snapshot.sessionId}). Get more output with this same bash tool using command exactly: ${LEGACY_JOB_COMMAND} ${snapshot.sessionId} (append --cancel to stop it). Do not rerun the original command.${retryHint}`
      : `Process is still running with session_id=${snapshot.sessionId}. Continue it with write_stdin.${retryHint}`
    : snapshot.signal === CODEX_UNCERTAIN_OUTCOME_SIGNAL
      ? "Process outcome is uncertain. Do not rerun the command blindly."
      : snapshot.signal
        ? `Process exited after signal ${snapshot.signal}.`
        : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
}

function processResult(snapshot: CodexProcessSnapshot, legacyShell = false): string {
  const status = processStatus(snapshot, legacyShell);
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
    retry_after_ms: z.number().int().nonnegative().optional(),
  });
}

function processToolResponse(snapshot: CodexProcessSnapshot, legacyShell = false) {
  const result = processResult(snapshot, legacyShell);
  // ChatGPT records both content and structuredContent in the conversation
  // transcript. Keep the full command output in one place only so every
  // command does not consume context twice.
  const content = [textBlock(processStatus(snapshot, legacyShell))];
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
      retry_after_ms: snapshot.retryAfterMs,
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
        "Apply a Codex-style patch to workspace files. Paths are workspace-relative.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        patch: z
          .string()
          .describe("Patch enclosed by *** Begin Patch / *** End Patch."),
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

interface ExecCommandInput {
  workspace_id: string;
  cmd: string;
  tty?: boolean;
  working_directory?: string;
  timeout_seconds?: number;
}

interface WriteStdinInput {
  workspace_id: string;
  session_id: string;
  chars?: string;
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const interactiveSessions = new Map<string, number>();
  registerExecCommandTool(context, interactiveSessions);
  registerWriteStdinTool(context, interactiveSessions);
}

function registerExecCommandTool(
  context: ToolRegistrationContext,
  interactiveSessions: Map<string, number>,
): void {
  context.server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a workspace command. If still running, continue its session_id with write_stdin; never rerun it. Use tty only for interactive input.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a PTY for interactive input."),
        working_directory: z
          .string()
          .optional()
          .describe("Workspace-relative working directory."),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .max(3_600)
          .optional()
          .describe("Optional non-interactive timeout, max 3600s."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async (input, extra) => handleExecCommand(context, interactiveSessions, input, extra),
  );
}

async function handleExecCommand(
  context: ToolRegistrationContext,
  interactiveSessions: Map<string, number>,
  input: ExecCommandInput,
  extra: unknown,
) {
  const { config } = context;
  const legacyShell = isLegacyShellCall(extra);
  const startedAt = performance.now();
  const workspaceId = input.workspace_id;
  const workingDirectory = input.working_directory;
  const snapshot = await runLoggedToolOperation(
    config,
    {
      tool: "exec_command",
      workspaceId,
      workingDirectory: workingDirectory ?? ".",
      command: input.cmd,
      commandLength: input.cmd.length,
    },
    startedAt,
    () => executeCodexCommand(
      context,
      interactiveSessions,
      input,
      legacyShell,
    ),
    processLogFields,
  );

  return processToolResponse(snapshot, legacyShell);
}

async function executeCodexCommand(
  context: ToolRegistrationContext,
  interactiveSessions: Map<string, number>,
  input: ExecCommandInput,
  legacyShell: boolean,
): Promise<CodexProcessSnapshot> {
  const { workspaces, processSessions, reactiveCommands } = context;
  const workspace = await workspaces.getWorkspace(input.workspace_id);
  const cwd = await workspaces.resolveWorkingDirectory(
    workspace,
    input.working_directory,
  );

  if (input.tty) {
    const process = await processSessions.start({
      workspaceId: input.workspace_id,
      command: input.cmd,
      cwd,
      workspaceRoot: workspace.root,
      tty: true,
      yieldTimeMs: DEFAULT_CODEX_INTERACTIVE_YIELD_MS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });
    if (!process.running || process.sessionId === undefined) {
      return codexInteractiveSnapshot(process);
    }
    const exposedSessionId = newCodexProcessSessionId();
    interactiveSessions.set(exposedSessionId, process.sessionId);
    return codexInteractiveSnapshot(process, exposedSessionId);
  }

  const receipt = reactiveCommands.start({
    workspace_id: input.workspace_id,
    workspace_root: workspace.root,
    command: input.cmd,
    cwd,
    event_type: CODEX_DURABLE_EVENT_TYPE,
    timeout_seconds: input.timeout_seconds,
  });
  const durableSnapshot = legacyShell
    ? await awaitDurableProcess(context, input.workspace_id, receipt.job_id)
    : await durableProcessSnapshot(
        context,
        input.workspace_id,
        receipt.job_id,
        DEFAULT_CODEX_YIELD_MS,
        DEFAULT_MAX_OUTPUT_TOKENS,
      );
  if (!durableSnapshot.running) {
    reactiveCommands.discardTerminal(receipt.job_id);
  }
  return durableSnapshot;
}

function registerWriteStdinTool(
  context: ToolRegistrationContext,
  interactiveSessions: Map<string, number>,
): void {
  context.server.registerTool(
    "write_stdin",
    {
      title: "Continue process",
      description:
        "Continue exec_command by session_id. Omit chars to wait; interactive sessions accept input; \\u0003 interrupts. Respect retry_after_ms.",
      inputSchema: {
        workspace_id: z
          .string()
          .describe("Workspace that started the process."),
        session_id: z
          .string()
          .min(1)
          .max(128)
          .describe("Session id from exec_command."),
        chars: z
          .string()
          .optional()
          .describe("Interactive input; omit to wait; \\u0003 interrupts."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async (input, extra) => handleWriteStdin(context, interactiveSessions, input, extra),
  );
}

async function handleWriteStdin(
  context: ToolRegistrationContext,
  interactiveSessions: Map<string, number>,
  input: WriteStdinInput,
  extra: unknown,
) {
  const { config } = context;
  const legacyShell = isLegacyShellCall(extra);
  const startedAt = performance.now();
  const snapshot = await runLoggedToolOperation(
    config,
    { tool: "write_stdin", workspaceId: input.workspace_id },
    startedAt,
    () => continueCodexProcess(context, interactiveSessions, input, legacyShell),
    processLogFields,
  );

  return processToolResponse(snapshot, legacyShell);
}

async function continueCodexProcess(
  context: ToolRegistrationContext,
  interactiveSessions: Map<string, number>,
  input: WriteStdinInput,
  legacyShell: boolean,
): Promise<CodexProcessSnapshot> {
  const { workspaces, processSessions, reactiveCommands } = context;
  await workspaces.getWorkspace(input.workspace_id);

  const interactiveSessionId = interactiveSessions.get(input.session_id);
  if (interactiveSessionId !== undefined) {
    const process = await processSessions.write({
      workspaceId: input.workspace_id,
      sessionId: interactiveSessionId,
      chars: input.chars,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });
    if (!process.running) interactiveSessions.delete(input.session_id);
    return codexInteractiveSnapshot(process, input.session_id);
  }

  const jobId = reactiveJobIdFromCodexSession(input.session_id);
  if (input.chars && input.chars !== "\u0003") {
    throw new Error(
      "This process session does not accept stdin. Start exec_command with tty=true for an input-driven process.",
    );
  }
  if (input.chars === "\u0003") {
    reactiveCommands.signal(jobId, input.workspace_id, "SIGINT");
  }
  return legacyShell
    ? awaitDurableProcess(context, input.workspace_id, jobId, LEGACY_SHELL_POLL_WAIT_MS)
    : durableProcessSnapshot(
        context,
        input.workspace_id,
        jobId,
        DEFAULT_CODEX_POLL_YIELD_MS,
        DEFAULT_MAX_OUTPUT_TOKENS,
      );
}

function isLegacyShellCall(extra: unknown): boolean {
  const headers = (extra as { requestInfo?: { headers?: unknown } } | undefined)?.requestInfo?.headers;
  if (headers instanceof Headers) return headers.get(LEGACY_SHELL_HEADER) === "1";
  return (headers as Record<string, unknown> | undefined)?.[LEGACY_SHELL_HEADER] === "1";
}

// A cached-catalog client continues through a translated @flyto2/job call.
// Return that continuation quickly instead of holding an MCP request open long
// enough for ChatGPT or an intermediary proxy to treat it as stalled.
async function awaitDurableProcess(
  context: ToolRegistrationContext,
  workspaceId: string,
  jobId: string,
  budgetMs = LEGACY_SHELL_WAIT_MS,
): Promise<CodexProcessSnapshot> {
  const deadline = Date.now() + budgetMs;
  let snapshot = await durableProcessSnapshot(context, workspaceId, jobId, Math.min(MAX_PROCESS_YIELD_MS, budgetMs));
  while (snapshot.running && Date.now() < deadline) {
    snapshot = await durableProcessSnapshot(
      context,
      workspaceId,
      jobId,
      Math.min(MAX_PROCESS_YIELD_MS, deadline - Date.now()),
    );
  }
  return snapshot;
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
    const evidence = reactiveCommands.readEvidence(job.evidence_ref, 1_024);
    const progress = runningProgressPreview(evidence.text);
    return {
      sessionId: codexSessionIdForReactiveJob(jobId),
      output: progress,
      outputTruncated: evidence.truncated || evidence.text.length > progress.length,
      running: true,
      wallTimeMs,
      retryAfterMs: DEFAULT_CODEX_RETRY_AFTER_MS,
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

function runningProgressPreview(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return "";
  if (trimmed.length <= RUNNING_PROGRESS_PREVIEW_CHARS) return trimmed;
  return `…${trimmed.slice(-RUNNING_PROGRESS_PREVIEW_CHARS)}`;
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
