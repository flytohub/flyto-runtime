// Existing ChatGPT connections can retain the upstream DevSpace tool schemas.
// Translate only the known legacy surface at the transport boundary; published
// Runtime schemas and durable-operation payloads remain canonical snake_case.
// Set by the transport on calls it translated from a cached `bash`. A client
// holding that catalog has no write_stdin, so the Codex process tools wait
// longer and describe continuation as another `bash` call instead.
export const LEGACY_SHELL_HEADER = "x-flyto2-legacy-shell";
export const LEGACY_JOB_COMMAND = "@flyto2/job";
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
    const job = typeof args.command === "string" ? LEGACY_JOB_COMMAND_PATTERN.exec(args.command.trim()) : null;
    if (job) {
      return {
        ...body,
        params: {
          ...params,
          name: "write_stdin",
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
