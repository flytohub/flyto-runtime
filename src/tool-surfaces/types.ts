import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import type { ServerConfig } from "../config.js";
import type { RuntimeEventStore } from "../flyto2/runtime-events.js";
import type { ReactiveCommandRunner } from "../flyto2/reactive-command.js";
import type { HostTaskStore } from "../flyto2/host-tasks.js";
import type { TaskPipelineRunner } from "../flyto2/task-pipeline.js";
import type { WorkspaceRegistry } from "../workspaces.js";

export const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  shell: "bash",
  runtimeManifest: "runtime_manifest",
  runtimeEvents: "runtime_events",
  runtimeWait: "runtime_wait",
  runtimeRun: "runtime_run",
  runtimeEvidence: "runtime_evidence",
  runtimeSignal: "runtime_signal",
  backgroundTask: "background_task",
  runtimeWatch: "runtime_watch",
  runtimeUnwatch: "runtime_unwatch",
  runtimeWatches: "runtime_watches",
} as const;

export const workspaceIdDescription =
  "Workspace to use. Reuse the current project's workspace_id.";

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  sessionId?: number | string;
  jobId?: string;
  running?: boolean;
  exitCode?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface DiffStats {
  additions: number;
  removals: number;
}

export interface ToolRegistrationContext {
  server: Pick<McpServer, "registerTool" | "registerResource">;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessSessionManager;
  runtimeEvents: RuntimeEventStore;
  reactiveCommands: ReactiveCommandRunner;
  hostTasks: Pick<
    HostTaskStore,
    "create" | "get" | "findLatestActiveByRoot" | "findLatestByRoot" | "adoptActive" | "checkpoint" | "updatePlan" | "complete" | "stop"
  >;
  taskPipelines: Pick<TaskPipelineRunner, "start">;
}

export interface ToolInstructionContext {
  agents: string;
  skills: string;
}

export interface ToolSurface {
  register(context: ToolRegistrationContext): void;
  instructions(context: ToolInstructionContext): string;
}
