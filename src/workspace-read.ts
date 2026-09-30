import { readFileTool, type ToolResponse } from "./pi-tools.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export const DEFAULT_WORKSPACE_READ_LIMIT_LINES = 240;
export const DEFAULT_WORKSPACE_READ_MAX_CHARS = 12_000;
const READ_TRUNCATION_MARKER =
  "\n... read output truncated; use a smaller line range or a targeted command ...\n";

export interface WorkspaceReadInput {
  workspaceId: string;
  path: string;
  offset?: number;
  limit?: number;
}

export interface WorkspaceReadResult {
  response: ToolResponse;
  result: string;
}

export async function readWorkspaceFile(
  workspaces: WorkspaceRegistry,
  input: WorkspaceReadInput,
): Promise<WorkspaceReadResult> {
  const workspace = await workspaces.getWorkspace(input.workspaceId);
  const readPath = await workspaces.resolveReadPath(workspace, input.path);
  const response = await readFileTool(
    {
      path: readPath.absolutePath,
      offset: input.offset,
      limit: input.limit ?? DEFAULT_WORKSPACE_READ_LIMIT_LINES,
    },
    { cwd: workspace.root },
  );
  const text = response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  return {
    response,
    result: truncateWorkspaceReadResult(text),
  };
}

export function truncateWorkspaceReadResult(result: string): string {
  if (result.length <= DEFAULT_WORKSPACE_READ_MAX_CHARS) return result;

  const available = DEFAULT_WORKSPACE_READ_MAX_CHARS - READ_TRUNCATION_MARKER.length;
  const tailChars = Math.min(1_000, Math.floor(available / 4));
  const headChars = available - tailChars;
  return `${result.slice(0, headChars)}${READ_TRUNCATION_MARKER}${result.slice(-tailChars)}`;
}
