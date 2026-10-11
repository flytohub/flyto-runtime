// Existing ChatGPT connections can retain the upstream DevSpace tool schemas.
// Translate only the known legacy surface at the transport boundary; published
// Runtime schemas and durable-operation payloads remain canonical snake_case.
// Set by the transport on calls it translated from a cached `bash`. A client
// holding that catalog has no process_status, so @flyto2/job is translated to
// the canonical immediate snapshot while cancellation remains write_stdin.
export const LEGACY_SHELL_HEADER = "x-flyto2-legacy-shell";
export const LEGACY_JOB_COMMAND = "@flyto2/job";
export const LEGACY_TASK_COMMAND = "@flyto2/task";
const LEGACY_JOB_COMMAND_PATTERN = /^@flyto2\/job\s+(proc_[a-f0-9]{32}|job_[a-f0-9]{32})(\s+--cancel)?$/;

export function normalizeLegacyMcpInput(body: unknown, toolMode?: "claude" | "codex"): unknown {
  if (!isRecord(body) || body.method !== "tools/call" || !isRecord(body.params)) return body;
  const params = body.params;
  if (typeof params.name !== "string" || !["open_workspace", "read", "write", "edit", "bash"].includes(params.name)) return body;
  if (!isRecord(params.arguments)) return body;
  const args = { ...params.arguments };
  const aliases = params.name === "open_workspace"
    ? { baseRef: "base_ref" }
    : { workspaceId: "workspace_id", workingDirectory: "working_directory" };
  for (const [legacy, canonical] of Object.entries(aliases)) {
    if (!Object.hasOwn(args, legacy)) continue;
    if (Object.hasOwn(args, canonical) && args[canonical] !== args[legacy]) {
      throw new Error(`Conflicting ${legacy} and ${canonical} arguments`);
    }
    args[canonical] = args[legacy];
    delete args[legacy];
  }

  if (params.name === "edit" && Array.isArray(args.edits)) {
    args.edits = args.edits.map((entry, index) => normalizeLegacyEditEntry(entry, index));
  }

  if (toolMode === "codex" && params.name === "bash") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    const task = parseLegacyTaskCommand(command, args.workspace_id);
    if (task) {
      return {
        ...body,
        params: {
          ...params,
          name: "background_task",
          arguments: task,
        },
      };
    }
    const job = LEGACY_JOB_COMMAND_PATTERN.exec(command);
    if (job) {
      return {
        ...body,
        params: {
          ...params,
          name: job[2] ? "write_stdin" : "process_status",
          arguments: {
            workspace_id: args.workspace_id,
            session_id: job[1],
            ...(job[2] ? { chars: "\u0003" } : {}),
          },
        },
      };
    }
    renameArgument(args, "command", "cmd");
    renameArgument(args, "timeout", "timeout_seconds");
    return { ...body, params: { ...params, name: "exec_command", arguments: args } };
  }

  return { ...body, params: { ...params, arguments: args } };
}

function parseLegacyTaskCommand(
  command: string,
  workspaceId: unknown,
): Record<string, unknown> | undefined {
  if (!command.startsWith(LEGACY_TASK_COMMAND + " ")) return undefined;
  if (typeof workspaceId !== "string" || !workspaceId.trim()) return undefined;

  const rest = command.slice(LEGACY_TASK_COMMAND.length).trim();
  if (rest.startsWith("start ")) {
    return {
      action: "start",
      workspace_id: workspaceId,
      prompt: rest.slice("start ".length).trim(),
    };
  }

  // Do not use backtracking regexes on caller-controlled commands. A cached
  // ChatGPT catalog can send arbitrarily long legacy shell strings here.
  const verbEnd = firstWhitespace(rest, 0);
  if (verbEnd === rest.length) return undefined;
  const verb = rest.slice(0, verbEnd);
  if (!["status", "wait", "continue", "complete", "stop"].includes(verb)) return undefined;

  const idStart = skipWhitespace(rest, verbEnd);
  if (idStart === rest.length) return undefined;
  const idEnd = firstWhitespace(rest, idStart);
  const taskId = rest.slice(idStart, idEnd);
  const promptStart = skipWhitespace(rest, idEnd);
  const hasPrompt = promptStart < rest.length;

  if (verb === "status" || verb === "wait") {
    if (hasPrompt) return undefined;
    return { action: verb, workspace_id: workspaceId, task_id: taskId, include_response: true };
  }
  if (verb === "continue" && !hasPrompt) return undefined;
  return {
    action: verb,
    workspace_id: workspaceId,
    task_id: taskId,
    ...(hasPrompt ? { prompt: rest.slice(promptStart).trim() } : {}),
  };
}

function firstWhitespace(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (/\s/u.test(value[index])) return index;
  }
  return value.length;
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/u.test(value[index])) index += 1;
  return index;
}

function renameArgument(
  args: Record<string, unknown>,
  legacy: string,
  canonical: string,
): void {
  if (!Object.hasOwn(args, legacy)) return;
  if (Object.hasOwn(args, canonical) && args[canonical] !== args[legacy]) {
    throw new Error(`Conflicting ${legacy} and ${canonical} arguments`);
  }
  args[canonical] = args[legacy];
  delete args[legacy];
}

function normalizeLegacyEditEntry(value: unknown, index: number): unknown {
  if (!isRecord(value)) return value;
  const entry = { ...value };
  for (const [legacy, canonical] of [
    ["oldText", "old_text"],
    ["newText", "new_text"],
  ] as const) {
    if (!Object.hasOwn(entry, legacy)) continue;
    if (Object.hasOwn(entry, canonical) && entry[canonical] !== entry[legacy]) {
      throw new Error(`Conflicting edits[${index}].${legacy} and edits[${index}].${canonical} arguments`);
    }
    entry[canonical] = entry[legacy];
    delete entry[legacy];
  }
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
