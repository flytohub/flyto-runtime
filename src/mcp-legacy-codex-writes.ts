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
  // Add File overwrites an existing file and always ends it with one newline.
  const body = normalizeEol(content).replace(/\n$/, "");
  const lines = body.split("\n").map((line) => `+${line}`);
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

export async function translateLegacyCodexWrite(
  body: unknown,
  resolvePath: LegacyWritePathResolver,
  readText: (absolutePath: string) => Promise<string>,
): Promise<unknown> {
  if (!isRecord(body) || body.method !== "tools/call" || !isRecord(body.params)) return body;
  const params = body.params;
  if (params.name !== "write" && params.name !== "edit") return body;
  const args = isRecord(params.arguments) ? params.arguments : {};
  const workspaceId = requireString(args.workspace_id, "workspace_id");
  const target = await resolvePath(workspaceId, requireString(args.path, "path"));

  let patch: string;
  if (params.name === "write") {
    patch = legacyWriteToPatch({ path: target.relativePath, content: requireString(args.content, "content") });
  } else {
    if (!Array.isArray(args.edits)) throw new Error("edits must be an array.");
    const edits = args.edits.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`edits[${index}] must be an object.`);
      return {
        old_text: requireString(entry.old_text, `edits[${index}].old_text`),
        new_text: requireString(entry.new_text, `edits[${index}].new_text`),
      };
    });
    patch = legacyEditToPatch({ path: target.relativePath, edits }, await readText(target.absolutePath));
  }

  return {
    ...body,
    params: {
      ...params,
      name: "apply_patch",
      arguments: {
        workspace_id: workspaceId,
        patch,
        ...(args.operation_id === undefined ? {} : { operation_id: args.operation_id }),
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
