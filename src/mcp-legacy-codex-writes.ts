// Cached ChatGPT connections can keep calling the upstream `write` and `edit`
// tools after the Runtime switched to the Codex surface, which only registers
// `apply_patch`. Translate those calls into one Codex patch so every file change
// still flows through the single audited apply_patch write path.

export interface LegacyWriteInput {
  path: string;
  content: string;
}

export interface LegacyEditInput {
  path: string;
  edits: Array<{ old_text: string; new_text: string }>;
}

export function legacyWriteToPatch({ path, content }: LegacyWriteInput): string {
  // Add File overwrites an existing file; the no-newline marker keeps content
  // that intentionally ends without one byte-for-byte.
  const normalized = normalizeEol(content);
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized === "" ? [] : normalized.replace(/\n$/, "").split("\n").map((line) => `+${line}`);
  if (!finalNewline) lines.push("\\ No newline at end of file");
  return ["*** Begin Patch", `*** Add File: ${path}`, ...lines, "*** End Patch"].join("\n");
}

// Mirrors the Claude-surface edit contract: every old_text must match exactly
// once in the original file and matches must not overlap. Each match is widened
// to whole lines because Codex hunks address lines, never partial lines; a
// widened line sequence still contains the unique old_text, so it is unique too.
export function legacyEditToPatch({ path, edits }: LegacyEditInput, original: string): string {
  if (edits.length === 0) throw new Error("edit requires at least one replacement.");
  const content = normalizeEol(original);

  const matches = edits.map((edit, index) => {
    const oldText = normalizeEol(edit.old_text);
    if (oldText === "") throw new Error(`edits[${index}].old_text must not be empty.`);
    const start = content.indexOf(oldText);
    if (start < 0) throw new Error(`edits[${index}].old_text was not found in ${path}.`);
    if (content.indexOf(oldText, start + 1) >= 0) {
      throw new Error(`edits[${index}].old_text matches more than once in ${path}; include more surrounding text.`);
    }
    return { index, start, end: start + oldText.length, newText: normalizeEol(edit.new_text) };
  }).sort((a, b) => a.start - b.start);

  for (let i = 1; i < matches.length; i += 1) {
    if (matches[i].start < matches[i - 1].end) {
      throw new Error(`edits[${matches[i - 1].index}] and edits[${matches[i].index}] overlap in ${path}.`);
    }
  }

  const groups: Array<{ lineStart: number; lineEnd: number; members: typeof matches }> = [];
  for (const match of matches) {
    const lineStart = content.lastIndexOf("\n", match.start - 1) + 1;
    const newlineAfter = content.indexOf("\n", match.end);
    const lineEnd = newlineAfter < 0 ? content.length : newlineAfter;
    const previous = groups.at(-1);
    if (previous && lineStart <= previous.lineEnd) {
      previous.lineEnd = Math.max(previous.lineEnd, lineEnd);
      previous.members.push(match);
    } else {
      groups.push({ lineStart, lineEnd, members: [match] });
    }
  }

  const hunks = groups.map(({ lineStart, lineEnd, members }) => {
    const before = content.slice(lineStart, lineEnd);
    let after = "";
    let cursor = lineStart;
    for (const member of members) {
      after += content.slice(cursor, member.start) + member.newText;
      cursor = member.end;
    }
    after += content.slice(cursor, lineEnd);
    // A match that consumed the file's final newline leaves `before` ending in
    // "\n"; the file split drops that trailing empty line, so the hunk must too.
    const consumedFinalNewline = before.endsWith("\n");
    const oldLines = before.replace(/\n$/, "").split("\n");
    const newLines = consumedFinalNewline && after === ""
      ? []
      : after.replace(/\n$/, "").split("\n");
    return ["@@", ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)];
  });

  return ["*** Begin Patch", `*** Update File: ${path}`, ...hunks.flat(), "*** End Patch"].join("\n");
}

function normalizeEol(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export interface LegacyWritePathResolver {
  // Returns the workspace-relative path and the canonical absolute path, after
  // the same approved-root containment the Claude-surface tools enforce.
  (workspaceId: string, path: string): Promise<{ relativePath: string; absolutePath: string }>;
}

// Journals one translation under the caller's operation_id. A retry must replay
// the patch produced the first time: re-reading a file the first attempt
// already changed would yield a different patch (or "old_text not found"), so
// apply_patch could never recognise the retry and replay its own result.
export type LegacyTranslationJournal = (
  operationId: string,
  payload: unknown,
  translate: () => Promise<string>,
) => Promise<string>;

export async function translateLegacyCodexWrite(
  body: unknown,
  resolvePath: LegacyWritePathResolver,
  readText: (absolutePath: string) => Promise<string>,
  journal?: LegacyTranslationJournal,
): Promise<unknown> {
  if (!isRecord(body) || body.method !== "tools/call" || !isRecord(body.params)) return body;
  const params = body.params;
  if (params.name !== "write" && params.name !== "edit") return body;
  const tool = params.name;
  const args = isRecord(params.arguments) ? params.arguments : {};
  const workspaceId = requireString(args.workspace_id, "workspace_id");
  const path = requireString(args.path, "path");
  const operationId = args.operation_id;
  if (operationId !== undefined && typeof operationId !== "string") {
    throw new Error("operation_id must be a string.");
  }

  const translate = async (): Promise<string> => {
    const target = await resolvePath(workspaceId, path);
    if (tool === "write") {
      return legacyWriteToPatch({ path: target.relativePath, content: requireString(args.content, "content") });
    }
    if (!Array.isArray(args.edits)) throw new Error("edits must be an array.");
    const edits = args.edits.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`edits[${index}] must be an object.`);
      return {
        old_text: requireString(entry.old_text, `edits[${index}].old_text`),
        new_text: requireString(entry.new_text, `edits[${index}].new_text`),
      };
    });
    return legacyEditToPatch({ path: target.relativePath, edits }, await readText(target.absolutePath));
  };

  const { operation_id: _operationId, ...legacyArgs } = args;
  const patch = operationId && journal
    ? await journal(operationId, { tool, arguments: legacyArgs }, translate)
    : await translate();

  return {
    ...body,
    params: {
      ...params,
      name: "apply_patch",
      arguments: {
        workspace_id: workspaceId,
        patch,
        ...(operationId === undefined ? {} : { operation_id: operationId }),
      },
    },
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
