import * as z from "zod/v4";
import type { ServerConfig } from "../config.js";
import type { McpRegistrationTarget } from "../mcp-modern-server.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import {
  textBlock,
} from "../tool-surfaces/shared.js";
import {
  toolNames,
  workspaceIdDescription,
} from "../tool-surfaces/types.js";
import { runtimeManifest } from "./manifest.js";
import type { RuntimeEventStore } from "./runtime-events.js";
import type { ReactiveCommandRunner } from "./reactive-command.js";
import type { WorkspaceWatchRegistry } from "./workspace-watch.js";

export interface RuntimeToolRegistrationContext {
  server: McpRegistrationTarget;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  runtimeEvents: RuntimeEventStore;
  reactiveCommands: ReactiveCommandRunner;
  workspaceWatches: WorkspaceWatchRegistry;
}

export function registerRuntimeTools(
  context: RuntimeToolRegistrationContext,
): void {
  const {
    server,
    config,
    workspaces,
    runtimeEvents,
    reactiveCommands,
    workspaceWatches,
  } = context;

  server.registerTool(
    toolNames.runtimeManifest,
    {
      title: "Runtime manifest",
      description:
        "Describe this standalone Flyto2 Runtime instance and its execution capabilities. Cloud integration is optional; this manifest is valid in direct MCP mode too.",
      inputSchema: {},
      outputSchema: {
        schema: z.literal("flyto2.execution.v1"),
        product: z.literal("Flyto2"),
        runtime: z.literal("flyto-runtime"),
        runtime_version: z.string(),
        runtime_id: z.string(),
        display_name: z.string(),
        platform: z.string(),
        roles: z.array(z.string()),
        capabilities: z.array(z.object({
          id: z.string(),
          revision: z.number().int(),
          risk_level: z.enum(["low", "medium", "high", "dangerous"]),
          approval: z.enum(["none", "policy", "explicit"]),
          evidence: z.array(z.string()),
        })),
      },
      annotations: { readOnlyHint: true },
    },
    async () => {
      const manifest = runtimeManifest(config);
      return {
        content: [textBlock(JSON.stringify(manifest, null, 2))],
        structuredContent: manifest,
      };
    },
  );

  server.registerTool(
    toolNames.runtimeEvents,
    {
      title: "Runtime events",
      description:
        "Read shallow Flyto2 Runtime events after a cursor. Use this for recovery or inspection, not for busy polling.",
      inputSchema: {
        after_sequence: z.number().int().nonnegative().optional(),
        workspace_id: z.string().optional(),
        type: z.string().optional(),
        correlation_id: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: {
        result: z.string(),
        events: z.array(z.object(runtimeEventOutputShape())),
        next_sequence: z.number().int().nonnegative(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ after_sequence, workspace_id, type, correlation_id, limit }) => {
      const events = runtimeEvents.list({
        after_sequence,
        workspace_id,
        type,
        correlation_id,
        limit,
      });
      const nextSequence =
        events.at(-1)?.sequence
        ?? after_sequence
        ?? runtimeEvents.latestSequence();
      return {
        content: [textBlock(
          events.length === 0
            ? `No Runtime events after sequence ${after_sequence ?? 0}.`
            : `Runtime events: ${events.length}; next_sequence=${nextSequence}.`,
        )],
        structuredContent: {
          result:
            events.length === 0
              ? "No matching Runtime events."
              : events
                  .map((event) => `#${event.sequence} ${event.type}: ${event.summary}`)
                  .join("\n"),
          events,
          next_sequence: nextSequence,
        },
      };
    },
  );

  server.registerTool(
    toolNames.runtimeWait,
    {
      title: "Wait for Runtime event",
      description:
        "Wait once for the next matching shallow Runtime event instead of repeatedly polling. Pass the last seen after_sequence to resume a stream. After a disconnect where a wait response may have been lost, pass the returned job/watch id as correlation_id together with its event type; without after_sequence Runtime will replay an already-persisted matching event before waiting for a future one.",
      inputSchema: {
        after_sequence: z.number().int().nonnegative().optional(),
        workspace_id: z.string().optional(),
        type: z.string().optional(),
        correlation_id: z.string().optional(),
        timeout_ms: z.number().int().min(0).max(25_000).optional(),
      },
      outputSchema: {
        result: z.string(),
        event: z.object(runtimeEventOutputShape()).nullable(),
        cursor: z.number().int().nonnegative(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ after_sequence, workspace_id, type, correlation_id, timeout_ms }) => {
      const cursor = after_sequence ?? (correlation_id ? 0 : runtimeEvents.latestSequence());
      const event = await runtimeEvents.wait({
        after_sequence: cursor,
        workspace_id,
        type,
        correlation_id,
        timeout_ms,
      });
      const nextCursor = event?.sequence ?? cursor;
      const result = event
        ? `#${event.sequence} ${event.type}: ${event.summary}`
        : `No matching event before timeout; cursor=${nextCursor}.`;
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          event: event ?? null,
          cursor: nextCursor,
        },
      };
    },
  );

  server.registerTool(
    toolNames.runtimeRun,
    {
      title: "Run reactive command",
      description:
        "Start a long-running command in the background and return immediately. Completion is published as a shallow Runtime event with an evidence reference; use runtime_wait instead of polling process output.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        command: z.string().min(1),
        working_directory: z.string().optional(),
        event_type: z.string().max(128).optional(),
      },
      outputSchema: {
        result: z.string(),
        job_id: z.string(),
        status: z.literal("running"),
        event_type: z.string(),
        evidence_ref: z.string(),
        command_digest: z.string(),
        started_at: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspace_id, command, working_directory, event_type }) => {
      const workspace = await workspaces.getWorkspace(workspace_id);
      const cwd = await workspaces.resolveWorkingDirectory(
        workspace,
        working_directory,
      );
      const receipt = reactiveCommands.start({
        workspace_id,
        workspace_root: workspace.root,
        command,
        cwd,
        event_type,
      });
      const result =
        `Reactive job ${receipt.job_id} started. Wait for ${receipt.event_type} with runtime_wait. If the connection drops, resume with correlation_id=${receipt.job_id} and type=${receipt.event_type} instead of rerunning the command; load ${receipt.evidence_ref} only if details are needed.`;
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          ...receipt,
        },
      };
    },
  );

  server.registerTool(
    toolNames.runtimeEvidence,
    {
      title: "Read Runtime evidence",
      description:
        "Read bounded local evidence for a Flyto2 Runtime event only when the shallow event is insufficient.",
      inputSchema: {
        reference: z.string(),
        max_characters: z.number().int().min(256).max(256_000).optional(),
      },
      outputSchema: {
        result: z.string(),
        job: z.object({
          job_id: z.string(),
          workspace_id: z.string(),
          command_digest: z.string(),
          event_type: z.string(),
          status: z.enum(["running", "completed", "failed", "orphaned"]),
          evidence_ref: z.string(),
          started_at: z.string(),
          completed_at: z.string().optional(),
          exit_code: z.number().int().optional(),
          signal: z.string().optional(),
        }),
        text: z.string(),
        truncated: z.boolean(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ reference, max_characters }) => {
      const evidence = reactiveCommands.readEvidence(
        reference,
        max_characters,
      );
      const result =
        `Evidence for ${evidence.job.job_id} (${evidence.job.status})${evidence.truncated ? " [truncated]" : ""}.\n${evidence.text}`;
      return {
        content: [textBlock(result)],
        structuredContent: {
          result,
          ...evidence,
        },
      };
    },
  );

  server.registerTool(
    toolNames.runtimeWatches,
    {
      title: "Runtime filesystem watches",
      description:
        "List persistent Flyto2 Runtime filesystem watches. Active watches survive Runtime restart and emit shallow events for external changes.",
      inputSchema: {
        workspace_id: z.string().optional(),
      },
      outputSchema: {
        result: z.string(),
        watches: z.array(z.object(workspaceWatchOutputShape())),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => {
      const watches = workspaceWatches.list(workspace_id);
      const result =
        watches.length === 0
          ? "No Runtime filesystem watches."
          : watches
              .map(
                (watch) =>
                  `${watch.watch_id} ${watch.status} ${watch.path} -> ${watch.event_type}`,
              )
              .join("\n");
      return {
        content: [textBlock(result)],
        structuredContent: { result, watches },
      };
    },
  );

  server.registerTool(
    toolNames.runtimeWatch,
    {
      title: "Watch workspace changes",
      description:
        "Start a persistent native filesystem watch for external changes made by editors, Git, build tools, or other local programs. The watch emits shallow Runtime events without polling and is restored after Runtime restart.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        path: z
          .string()
          .optional()
          .describe("Existing file or directory relative to the workspace root. Defaults to the workspace root."),
        recursive: z
          .boolean()
          .optional()
          .describe("Recursively watch a directory. Defaults to true for directories and false for files."),
        event_type: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe("Event type to emit. Defaults to file.changed."),
        debounce_ms: z
          .number()
          .int()
          .min(20)
          .max(2_000)
          .optional()
          .describe("Fixed event batching window. Defaults to 120ms."),
      },
      outputSchema: {
        result: z.string(),
        watch: z.object(workspaceWatchOutputShape()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, path, recursive, event_type, debounce_ms }) => {
      const workspace = await workspaces.getWorkspace(workspace_id);
      const displayPath = path?.trim() || ".";
      const targetPath = await workspaces.resolvePath(workspace, displayPath);
      const watch = workspaceWatches.start({
        workspace_id,
        workspace_root: workspace.root,
        canonical_root: workspace.canonicalRoot,
        target_path: targetPath,
        display_path: displayPath,
        recursive,
        event_type,
        debounce_ms,
      });
      const result =
        `Watching ${watch.path} as ${watch.watch_id}; external changes emit ${watch.event_type}.`;
      return {
        content: [textBlock(result)],
        structuredContent: { result, watch },
      };
    },
  );

  server.registerTool(
    toolNames.runtimeUnwatch,
    {
      title: "Stop workspace watch",
      description:
        "Stop a persistent Flyto2 Runtime filesystem watch. Use a stable operation_id when retrying after a lost response.",
      inputSchema: {
        watch_id: z.string().min(1),
      },
      outputSchema: {
        result: z.string(),
        watch: z.object(workspaceWatchOutputShape()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ watch_id }) => {
      const watch = workspaceWatches.stop(watch_id);
      const result = `Stopped Runtime filesystem watch ${watch.watch_id}.`;
      return {
        content: [textBlock(result)],
        structuredContent: { result, watch },
      };
    },
  );

  server.registerTool(
    toolNames.runtimeSignal,
    {
      title: "Signal Runtime event",
      description:
        "Publish a shallow custom event into the durable Flyto2 Runtime event stream. Use stable operation_id when retrying a lost response.",
      inputSchema: {
        type: z.string().min(1).max(128),
        workspace_id: z.string().optional(),
        correlation_id: z.string().max(128).optional(),
        summary: z.string().max(1200).optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      },
      outputSchema: {
        result: z.string(),
        event: z.object(runtimeEventOutputShape()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ type, workspace_id, correlation_id, summary, payload }) => {
      const event = runtimeEvents.append({
        type,
        source: "mcp",
        workspace_id,
        correlation_id,
        summary,
        payload,
      });
      const result = `Published Runtime event #${event.sequence} ${event.type}.`;
      return {
        content: [textBlock(result)],
        structuredContent: { result, event },
      };
    },
  );
}

function workspaceWatchOutputShape(): z.ZodRawShape {
  return {
    watch_id: z.string(),
    workspace_id: z.string(),
    path: z.string(),
    recursive: z.boolean(),
    event_type: z.string(),
    debounce_ms: z.number().int(),
    status: z.enum(["active", "stopped", "error"]),
    created_at: z.string(),
    updated_at: z.string(),
  };
}

function runtimeEventOutputShape(): z.ZodRawShape {
  return {
    sequence: z.number().int().nonnegative(),
    event_id: z.string(),
    type: z.string(),
    source: z.string(),
    workspace_id: z.string().optional(),
    correlation_id: z.string().optional(),
    summary: z.string(),
    payload: z.record(z.string(), z.unknown()),
    evidence: z.array(z.object({
      kind: z.string(),
      ref: z.string(),
      sha256: z.string().optional(),
      size: z.number().int().nonnegative().optional(),
    })),
    occurred_at: z.string(),
  };
}
