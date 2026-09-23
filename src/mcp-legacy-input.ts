// Existing ChatGPT connections can retain the upstream DevSpace tool schemas.
// Translate only the known legacy surface at the transport boundary; published
// Runtime schemas and durable-operation payloads remain canonical snake_case.
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

  if (toolMode === "codex") {
    if (params.name === "bash") {
      renameArgument(args, "command", "cmd");
      renameArgument(args, "timeout", "timeout_seconds");
      return { ...body, params: { ...params, name: "exec_command", arguments: args } };
    }
    if (params.name === "write") {
      const workspaceId = args.workspace_id;
      const path = args.path;
      const content = args.content;
      if (typeof workspaceId !== "string" || typeof path !== "string" || typeof content !== "string") {
        throw new Error("Legacy write requires workspaceId, path, and content");
      }
      return {
        ...body,
        params: {
          ...params,
          name: "apply_patch",
          arguments: {
            workspace_id: workspaceId,
            patch: legacyWritePatch(path, content),
          },
        },
      };
    }
    if (params.name === "edit") {
      const workspaceId = args.workspace_id;
      const path = args.path;
      const edits = args.edits;
      if (typeof workspaceId !== "string" || typeof path !== "string" || !Array.isArray(edits)) {
        throw new Error("Legacy edit requires workspaceId, path, and edits");
      }
      return {
        ...body,
        params: {
          ...params,
          name: "apply_patch",
          arguments: {
            workspace_id: workspaceId,
            patch: legacyEditPatch(path, edits),
          },
        },
      };
    }
  }

  return { ...body, params: { ...params, arguments: args } };
}

function legacyWritePatch(path: string, content: string): string {
  const safePath = patchPath(path);
  const normalized = content.replace(/\r\n/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();

  const body = lines.map((line) => "+" + line);
  if (!finalNewline) body.push("\\ No newline at end of file");

  return [
    "*** Begin Patch",
    "*** Add File: " + safePath,
    ...body,
    "*** End Patch",
  ].join("\n");
}

function legacyEditPatch(path: string, edits: unknown[]): string {
  const safePath = patchPath(path);
  if (edits.length === 0) throw new Error("Legacy edit requires at least one edit");

  const hunks: string[] = [];
  for (const [index, value] of edits.entries()) {
    if (!isRecord(value) || typeof value.old_text !== "string" || typeof value.new_text !== "string") {
      throw new Error("Legacy edit entry " + index + " requires oldText and newText");
    }
    if (value.old_text.length === 0) {
      throw new Error("Legacy edit entry " + index + " oldText cannot be empty");
    }
    hunks.push("@@");
    for (const line of value.old_text.replace(/\r\n/g, "\n").split("\n")) {
      hunks.push("-" + line);
    }
    for (const line of value.new_text.replace(/\r\n/g, "\n").split("\n")) {
      hunks.push("+" + line);
    }
  }

  return [
    "*** Begin Patch",
    "*** Update File: " + safePath,
    ...hunks,
    "*** End Patch",
  ].join("\n");
}

function patchPath(path: string): string {
  if (!path || path.includes("\n") || path.includes("\r")) {
    throw new Error("Legacy file path must be a non-empty single line");
  }
  return path;
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
