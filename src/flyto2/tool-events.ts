import type { DurableToolCompletion } from "./durable-tools.js";
import type { RuntimeEventStore } from "./runtime-events.js";

const FILE_MUTATION_TOOLS = new Set(["write", "edit", "apply_patch"]);

export async function emitDurableToolEvent(
  events: RuntimeEventStore,
  completion: DurableToolCompletion,
): Promise<void> {
  const workspaceId = stringField(completion.input, "workspace_id");

  if (FILE_MUTATION_TOOLS.has(completion.tool)) {
    events.append({
      type: "workspace.changed",
      source: "mcp",
      workspace_id: workspaceId,
      summary: `${completion.tool} changed workspace content.`,
      payload: {
        tool: completion.tool,
        path: stringField(completion.input, "path"),
      },
    });
    return;
  }

  if (completion.tool === "open_workspace") {
    const structured = structuredContent(completion.result);
    events.append({
      type: "workspace.opened",
      source: "mcp",
      workspace_id:
        stringField(structured, "workspace_id")
        ?? workspaceId,
      summary: "Workspace opened or reused.",
      payload: {
        mode: stringField(structured, "mode"),
      },
    });
    return;
  }

  if (
    completion.tool === "bash"
    || completion.tool === "exec_command"
    || completion.tool === "write_stdin"
  ) {
    const structured = structuredContent(completion.result);
    events.append({
      type: "tool.completed",
      source: "mcp",
      workspace_id: workspaceId,
      summary: `${completion.tool} completed.`,
      payload: {
        tool: completion.tool,
        running: booleanField(structured, "running"),
        exit_code: numberField(structured, "exit_code"),
        session_id: numberField(structured, "session_id"),
      },
    });
  }
}

function structuredContent(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const structured = (value as Record<string, unknown>).structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return {};
  return structured as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}
