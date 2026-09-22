// Existing ChatGPT connections can retain the upstream DevSpace tool schemas.
// Translate only the known legacy surface at the transport boundary; published
// Runtime schemas and durable-operation payloads remain canonical snake_case.
export function normalizeLegacyMcpInput(body: unknown): unknown {
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

  return { ...body, params: { ...params, arguments: args } };
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
