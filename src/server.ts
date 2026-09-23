import { AccessDeniedError } from "./roots.js";
import { LEGACY_SHELL_HEADER, normalizeLegacyMcpInput } from "./mcp-legacy-input.js";
import { translateLegacyCodexWrite } from "./mcp-legacy-codex-writes.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { join, relative as relativePath } from "node:path";
import { flyto2RuntimePackageRoot } from "./flyto2/macos-launcher.js";
import { flyto2NativeRuntimeHome } from "./flyto2/native-paths.js";
import { setDevspaceConfigValues } from "./user-config.js";
import { fetchQuickTunnelHostname, quickTunnelUrlChange, readQuickTunnelProfile } from "./flyto2/quick-tunnel.js";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
} from "./logger.js";
import { readFileTool } from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  compileMcpRegistrationSurface,
  createModernMcpServerAdapter,
  modernMcpAdapterErrorLogFields,
  type McpRegistrationTarget,
} from "./mcp-modern-server.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { DEVSPACE_VERSION } from "./version.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { DurableOperationStore, runDurableOperation } from "./flyto2/durable-operations.js";
import {
  nativeTunnelManagementSupported,
  nativeTunnelReadiness,
  shouldRepairNativeTunnelRedundancy,
} from "./flyto2/native-tunnel.js";
import { withDurableToolHandlers } from "./flyto2/durable-tools.js";
import { registerRuntimeTools } from "./flyto2/runtime-tools.js";
import { RuntimeEventStore } from "./flyto2/runtime-events.js";
import { ReactiveCommandRunner } from "./flyto2/reactive-command.js";
import { emitDurableToolEvent } from "./flyto2/tool-events.js";
import { WorkspaceWatchRegistry } from "./flyto2/workspace-watch.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
  workspaceAppDescriptorMeta,
} from "./tool-surfaces/shared.js";
import {
  WORKSPACE_APP_URI,
  toolNames,
  workspaceIdDescription,
  type ToolContent,
  type ToolSurface,
} from "./tool-surfaces/types.js";

const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
function mcpServerInfo() {
  return {
    name: "flyto2-runtime",
    title: "Flyto2 Runtime",
    version: DEVSPACE_VERSION,
    description:
      "Standalone local execution runtime for Flyto2 and MCP hosts. Open each project or worktree once, then reuse its workspace_id.",
  };
}

interface RunningServer {
  app: ReturnType<typeof express>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderStatus[];
  close(): Promise<void>;
}

type TrackToolActivity = <T>(operation: () => Promise<T>) => Promise<T>;

class ToolActivityTracker {
  private readonly active = new Set<Promise<unknown>>();

  readonly track: TrackToolActivity = <T>(operation: () => Promise<T>): Promise<T> => {
    const promise = operation();
    this.active.add(promise);
    const remove = () => this.active.delete(promise);
    void promise.then(remove, remove);
    return promise;
  };

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled(Array.from(this.active));
    }
  }
}

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

function allowedRootsSentence(allowedRoots: readonly string[]): string {
  return allowedRoots.length === 0
    ? "No allowed roots are configured; ask the user to add one with flyto2-runtime setup."
    : `Allowed roots: ${allowedRoots.join(", ")}. To find a folder the user names, open the allowed root and list it; do not search outside these roots.`;
}

function serverInstructions(
  config: ServerConfig,
  toolSurface: ToolSurface,
): string {
  const artifactInstruction =
    config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
      ? " When the user provides an attached or generated file that needs to be added to the workspace, pass the provided file directly to download_artifact with the existing workspace_id and a suitable relative destination path. Do not reconstruct attached files manually."
      : "";
  const showChangesInstruction =
    " If files are modified, call show_changes once after the final related change and before the final response.";
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches one, use ${toolNames.read} with the returned skill path before proceeding. `
    : "";
  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in available_agents_files, use ${toolNames.read} to inspect that instruction file and follow it. `;
  const common = `Call ${toolNames.openWorkspace} when starting work in a project folder or isolated worktree without a usable workspace_id, then reuse the returned workspace_id for subsequent operations in that workspace.`;
  const execution = config.toolMode === "codex"
    ? " For a command that returns running=true, continue its session_id with write_stdin. Do not rerun the original command while that process session is available."
    : ` Long bash commands automatically continue as durable Flyto2 Runtime jobs. Follow any returned @flyto2/job <job_id> command later; never rerun the original side effect just because it is still running or a response was lost.`;
  const diagnostics = config.exposeRuntimeInternals
    ? ` Diagnostic Runtime internals are explicitly enabled. Use ${toolNames.runtimeEvents}, ${toolNames.runtimeWait}, ${toolNames.runtimeEvidence}, or watch tools only when diagnosing Runtime behavior; normal coding should still use the primary workspace/file/process primitives.`
    : "";

  return `${common} ${toolSurface.instructions({ agents, skills })}${execution}${diagnostics}${artifactInstruction}${showChangesInstruction}${selfUpdateInstruction()}`;
}

// A remote host can only update a Runtime it cannot restart by hand if it knows
// the command; the background service's PATH does not include the CLI shim.
function selfUpdateInstruction(): string {
  if (process.env.FLYTO2_RUNTIME_MANAGED_SERVICE !== "1") return "";
  if (process.platform !== "darwin" && process.platform !== "win32") return "";
  const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(flyto2RuntimePackageRoot(), "dist", "cli.js"))}`;
  return ` Only when the user asks to update Flyto2 Runtime itself, run \`${cli} service self-update\` and later \`${cli} service self-update status\`; the connection drops for a few seconds while it restarts, then retry.`;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const effort = agent.effort ? `, effort ${agent.effort}` : "";
  return `${agent.name} (${agent.provider}${model}${effort})`;
}

function formatAvailableAgentProvider(provider: {
  id: string;
  model?: string;
  effort?: string;
  note?: string;
}): string {
  const details = [
    provider.model ? `model ${provider.model}` : undefined,
    provider.effort ? `effort ${provider.effort}` : undefined,
    provider.note,
  ].filter(Boolean).join(", ");
  return `${provider.id}${details ? ` (${details})` : ""}`;
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function shouldTrustLocalPublicProxy(config: ServerConfig): boolean {
  if (config.logging.trustProxy) return false;
  const bindHost = config.host.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "::1", "localhost"].includes(bindHost)) return false;
  const publicHost = new URL(config.publicBaseUrl).hostname.replace(/^\[|\]$/g, "");
  return !["127.0.0.1", "::1", "localhost"].includes(publicHost);
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  durableOperations: DurableOperationStore,
  runtimeEvents: RuntimeEventStore,
  reactiveCommands: ReactiveCommandRunner,
  workspaceWatches: WorkspaceWatchRegistry,
  trackToolActivity?: TrackToolActivity,
): McpServer {
  const toolSurface = getToolSurface(config.toolMode);
  const server = new McpServer(
    mcpServerInfo(),
    {
      instructions: serverInstructions(config, toolSurface),
    },
  );

  registerMcpSurface(
    server,
    config,
    workspaces,
    reviewCheckpoints,
    processSessions,
    resolveLocalAgentProviders,
    incomingArtifactAdapters,
    durableOperations,
    runtimeEvents,
    reactiveCommands,
    workspaceWatches,
    trackToolActivity,
  );
  return server;
}

function registerMcpSurface(
  server: McpRegistrationTarget,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  durableOperations: DurableOperationStore,
  runtimeEvents: RuntimeEventStore,
  reactiveCommands: ReactiveCommandRunner,
  workspaceWatches: WorkspaceWatchRegistry,
  trackToolActivity?: TrackToolActivity,
): void {
  const trackedTarget = trackToolActivity
    ? withTrackedToolHandlers(server, trackToolActivity)
    : server;
  const registrationTarget = withDurableToolHandlers(
    trackedTarget,
    durableOperations,
    {
      onCompleted: (completion) => emitDurableToolEvent(runtimeEvents, completion),
    },
  );
  const toolSurface = getToolSurface(config.toolMode);

  registerAppResource(
    registrationTarget,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    registrationTarget,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Start work in a project directory or isolated worktree when no usable workspace_id exists for it. During continued work, reuse the existing workspace_id instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
      inputSchema: {
        path: z
          .string()
          .describe(
            `Absolute path, or a leading-tilde home path such as ~/project, to a project directory inside an allowed root. ${allowedRootsSentence(config.allowedRoots)}`,
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work.",
          ),
        base_ref: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspace_id: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        source_root: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            base_ref: z.string(),
            base_sha: z.string(),
            dirty_source: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agents_files: z.array(workspaceAgentsFileOutputSchema).optional(),
        available_agents_files: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agent_providers: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skill_diagnostics: z.array(z.unknown()).optional(),
        review: z.discriminatedUnion("available", [
          z.object({ available: z.literal(true) }),
          z.object({
            available: z.literal(false),
            reason: z.string(),
          }),
        ]),
        instruction: z.string(),
      },
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, base_ref }, { _meta }) => {
      const startedAt = performance.now();
      const baseRef = base_ref;
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, mode, baseRef },
        { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) },
      ).catch((error: unknown) => {
        // The host cannot see the filesystem: name the roots it may use, so it
        // opens one and looks inside instead of guessing or searching $HOME.
        if (error instanceof AccessDeniedError) {
          throw new AccessDeniedError(`${error.message}. ${allowedRootsSentence(config.allowedRoots)}`);
        }
        throw error;
      });
      const review = await reviewCheckpoints.initializeWorkspace({
        workspaceId: workspace.id,
        root: workspace.root,
      });
      const preloadSubagents = config.subagents.enabled
        && config.subagents.instructions === "preload";
      const subagentsSkill = workspace.skills.find((skill) => skill.name === "subagents");
      const preloadedSubagentInstructions = preloadSubagents && subagentsSkill
        ? readFileSync(subagentsSkill.filePath, "utf8")
        : undefined;
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .filter((skill) => !(preloadSubagents && skill.name === "subagents"))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const agentCatalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const cardAgentProviders = agentCatalog.providers
        .filter((provider) => provider.usable)
        .map((provider) => ({
          id: provider.id,
          model: provider.model,
          effort: provider.effort,
          note: provider.note,
        }));
      const cardAgents = agentCatalog.profiles;
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const cardInstruction = config.skillsEnabled
        ? "Use this workspace_id for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agents_files instructions. Before working under a path listed in available_agents_files, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspace_id for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agents_files instructions. Before working under a path listed in available_agents_files, read that instruction file.";
      const workspaceInstruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspace_id.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspace_id for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
          : cardInstruction;
      const legacyReactiveInstruction = config.toolMode === "claude"
        ? "Long bash commands automatically continue as durable Flyto2 Runtime jobs. Follow any returned @flyto2/job <job_id> command later; do not rerun the original side effect while it is still running."
        : undefined;
      const instructionParts = [
        workspaceInstruction,
        legacyReactiveInstruction,
        ...(preloadedSubagentInstructions && includeBootstrapContext
          ? ["Subagent workflow instructions:", preloadedSubagentInstructions]
          : []),
      ].filter((part): part is string => Boolean(part));
      const instruction = instructionParts.join("\n\n");
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.length > 0
              ? `Available subagent providers: ${visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            availableAgentsFiles: cardAvailableAgentsFiles,
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            review,
            instruction: cardInstruction,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          workspace_id: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          source_root: workspace.sourceRoot,
          worktree: workspace.worktree
            ? {
                path: workspace.worktree.path,
                base_ref: workspace.worktree.baseRef,
                base_sha: workspace.worktree.baseSha,
                dirty_source: workspace.worktree.dirtySource,
                detached: workspace.worktree.detached,
                managed: workspace.worktree.managed,
              }
            : undefined,
          review,
          ...(includeBootstrapContext
            ? {
                agents_files: loadedAgentsFiles,
                available_agents_files: availableAgentsFileOutputs,
                skills: visibleSkills,
                agent_providers: visibleAgentProviders,
                agents: visibleAgents,
                skill_diagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
        },
      };
    },
  );

  registrationTarget.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read all or part of a file in a workspace.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read the returned skill path before proceeding."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspace_id: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path relative to the workspace root, or a skill path returned by open_workspace."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, ...input }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const readPath = await workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        { cwd: workspace.root },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  if (config.exposeRuntimeInternals) {
    registerRuntimeTools({
      server: registrationTarget,
      config,
      workspaces,
      runtimeEvents,
      reactiveCommands,
      workspaceWatches,
    });
  }

  toolSurface.register({
    server: registrationTarget,
    config,
    workspaces,
    processSessions,
    runtimeEvents,
    reactiveCommands,
  });

  registerAppTool(
    registrationTarget,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        workspace_id: z.string(),
        review_ref: z.string().regex(/^[0-9a-f]{40,64}$/),
      }),
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }, { _meta }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const reviewRef = typeof _meta?.["devspace/reviewRef"] === "string"
        ? _meta["devspace/reviewRef"]
        : undefined;
      const review = reviewRef
        ? await reviewCheckpoints.reviewByRef({
            workspaceId,
            root: workspace.root,
            reviewRef,
          })
        : await reviewCheckpoints.reviewChanges({
            workspaceId,
            root: workspace.root,
            markReviewed: true,
          });

      const content = [textBlock(review.result)];
      logToolCall(config, {
        tool: "show_changes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          card: {
            workspaceId,
            summary: review.summary,
            files: review.files,
            payload: {
              patch: review.patch,
            },
          },
        },
        structuredContent: {
          workspace_id: workspaceId,
          review_ref: review.reviewRef,
          result: contentText(content),
        },
      };
    },
  );

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(registrationTarget, {
      config,
      workspaces,
      incomingArtifactAdapters,
    });
  }
}

function withTrackedToolHandlers(
  server: McpRegistrationTarget,
  trackToolActivity: TrackToolActivity,
): McpRegistrationTarget {
  return {
    registerTool: ((...args: unknown[]) => {
      const handler = args.at(-1) as (...handlerArgs: unknown[]) => unknown;
      return (server.registerTool as (...callArgs: unknown[]) => unknown)(
        ...args.slice(0, -1),
        (...handlerArgs: unknown[]) => trackToolActivity(
          () => Promise.resolve(handler(...handlerArgs)),
        ),
      );
    }) as McpRegistrationTarget["registerTool"],
    registerResource: server.registerResource.bind(server),
  };
}

// A quick tunnel's URL changes whenever cloudflared restarts. The saved public
// URL decides which Host headers and OAuth resource this process accepts, so a
// stale one locks every client out. Save the live URL and exit; the service
// manager restarts this process with it (a non-zero code, because the Windows
// supervisor treats exit 0 as a deliberate stop).
const QUICK_TUNNEL_RESTART_EXIT_CODE = 75;

function startQuickTunnelFollower(config: ServerConfig, enabled: boolean): () => void {
  if (!enabled) return () => {};
  let stopped = false;
  const check = async () => {
    const profile = readQuickTunnelProfile(flyto2NativeRuntimeHome());
    if (stopped || !profile) return;
    const next = quickTunnelUrlChange(config.publicBaseUrl, await fetchQuickTunnelHostname(profile.metrics_port));
    if (stopped || !next) return;
    setDevspaceConfigValues([{ path: ["server", "publicBaseUrl"], value: next }]);
    logEvent(config.logging, "warn", "quick_tunnel_url_changed", { from: config.publicBaseUrl, to: next });
    if (process.env.FLYTO2_RUNTIME_MANAGED_SERVICE === "1") process.exit(QUICK_TUNNEL_RESTART_EXIT_CODE);
  };
  const interval = setInterval(() => void check().catch(() => {}), 10_000);
  interval.unref();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function startNativeTunnelWatchdog(
  config: ServerConfig,
  enabled: boolean,
): () => void {
  if (!enabled || !nativeTunnelManagementSupported()) return () => {};

  let stopped = false;
  let checking = false;
  let repairAttempt = 0;
  let nextRepairAt = 0;

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const readiness = await nativeTunnelReadiness();
      if (!shouldRepairNativeTunnelRedundancy(readiness)) {
        repairAttempt = 0;
        nextRepairAt = 0;
        return;
      }
      const now = Date.now();
      if (now < nextRepairAt) return;
      const cliPath = process.argv[1];
      if (!cliPath) return;

      const backoffMs = Math.min(30_000, 2_000 * (2 ** Math.min(repairAttempt, 4)));
      nextRepairAt = now + backoffMs;
      repairAttempt += 1;
      const child = spawn(
        process.execPath,
        [cliPath, "service", "tunnel-start"],
        {
          detached: true,
          stdio: "ignore",
          env: process.env,
          windowsHide: true,
        },
      );
      child.unref();
      logEvent(config.logging, "warn", "tunnel_repair_started", {
        readyConnectors: readiness.ready_connectors,
        connectorCount: readiness.connector_count,
        repairAttempt,
        nextRetryMs: backoffMs,
      });
    } catch (error) {
      logEvent(config.logging, "warn", "tunnel_watchdog_check_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      checking = false;
    }
  };

  const initial = setTimeout(() => void check(), 750);
  const interval = setInterval(() => void check(), 5_000);
  initial.unref();
  interval.unref();

  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
  nativeTunnelWatchdog?: boolean;
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = express();
  // The MCP SDK helper currently hard-codes Express' default 100 KB JSON
  // parser limit. Real edit/write/tool payloads can legitimately exceed that,
  // so use a bounded Runtime-owned limit instead of surfacing a transport-level
  // 413 that MCP hosts often present as a connection interruption.
  app.use(express.json({ limit: "4mb" }));
  if (allowedHosts) {
    app.use(hostHeaderValidation(allowedHosts));
  } else if (["127.0.0.1", "localhost", "::1"].includes(config.host)) {
    app.use(localhostHostValidation());
  }
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const durableOperations = new DurableOperationStore(config.stateDir);
  const runtimeEvents = new RuntimeEventStore(config.stateDir);
  const reactiveCommands = new ReactiveCommandRunner(config.stateDir, runtimeEvents);
  const workspaceWatches = new WorkspaceWatchRegistry(config.stateDir, runtimeEvents);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const toolActivities = new ToolActivityTracker();
  const localAgentProviders = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
  );
  const stopNativeTunnelWatchdog = startNativeTunnelWatchdog(
    config,
    options.nativeTunnelWatchdog === true,
  );
  const stopQuickTunnelFollower = startQuickTunnelFollower(
    config,
    options.nativeTunnelWatchdog === true,
  );
  const resolveLocalAgentProviders = config.subagents.enabled
    ? () => buildLocalAgentProviderStatuses(
        config.subagents,
        getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
      )
    : () => localAgentProviders;
  const modernToolSurface = getToolSurface(config.toolMode);
  const bindModernMcpSurface = compileMcpRegistrationSurface((target) => {
    registerMcpSurface(
      target,
      config,
      workspaces,
      reviewCheckpoints,
      processSessions,
      resolveLocalAgentProviders,
      incomingArtifactAdapters,
      durableOperations,
      runtimeEvents,
      reactiveCommands,
      workspaceWatches,
      toolActivities.track,
    );
  });
  const logMcpHandlerError = (error: Error) => logEvent(
    config.logging,
    "error",
    "mcp_handler_error",
    modernMcpAdapterErrorLogFields(error),
  );
  const mcpHandler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter(
      mcpServerInfo(),
      { instructions: serverInstructions(config, modernToolSurface) },
    );
    bindModernMcpSurface(adapter.registrationTarget);
    return adapter.server;
  }, {
    legacy: "stateless",
    onerror: logMcpHandlerError,
  });
  const mcpNodeHandler = toNodeHandler(mcpHandler, {
    onerror: logMcpHandlerError,
  });

  const proxyTrustMode = config.logging.trustProxy
    ? "configured"
    : shouldTrustLocalPublicProxy(config)
      ? "loopback-public-proxy"
      : "disabled";
  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  } else if (proxyTrustMode === "loopback-public-proxy") {
    // Runtime binds to loopback while a local tunnel/reverse proxy owns the public edge.
    // Trust only loopback peers so proxy-aware middleware can safely interpret forwarded headers.
    app.set("trust proxy", "loopback");
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      name: "flyto2-runtime",
      product: "Flyto2",
    });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !oauthProvider.isResourceAllowed(req.auth.resource)) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
    });

    let requestBody: unknown;
    try {
      const legacyToolName = config.toolMode === "codex" && req.body?.method === "tools/call"
        ? req.body?.params?.name
        : undefined;
      delete req.headers[LEGACY_SHELL_HEADER];
      requestBody = normalizeLegacyMcpInput(req.body, config.toolMode);
      if (legacyToolName === "bash") {
        req.headers[LEGACY_SHELL_HEADER] = "1";
        req.headers["mcp-name"] = (requestBody as { params: { name: string } }).params.name;
      }
      if (legacyToolName === "write" || legacyToolName === "edit") {
        requestBody = await translateLegacyCodexWrite(
          requestBody,
          async (workspaceId, path) => {
            const workspace = await workspaces.getWorkspace(workspaceId);
            const absolutePath = await workspaces.resolvePath(workspace, path);
            return { absolutePath, relativePath: relativePath(workspace.canonicalRoot, absolutePath) };
          },
          (absolutePath) => readFile(absolutePath, "utf8"),
          async (operationId, payload, translate) => {
            // Derived key: the caller's operation_id itself journals apply_patch.
            const journalId = `legacy-translation:${createHash("sha256").update(operationId).digest("hex").slice(0, 40)}`;
            const translated = await runDurableOperation(
              durableOperations,
              { tool: "legacy_codex_translation", operationId: journalId, payload },
              translate,
            );
            return translated.value;
          },
        );
        req.headers["mcp-name"] = "apply_patch";
      }
    } catch (error) {
      sendJsonRpcError(res, 400, -32602, error instanceof Error ? error.message : "Invalid tool arguments");
      return;
    }
    try {
      await mcpNodeHandler(req, res, requestBody);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        try {
          await mcpHandler.close();
        } catch (error) {
          logEvent(config.logging, "warn", "mcp_handler_close_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await toolActivities.waitForIdle();
        stopNativeTunnelWatchdog();
        stopQuickTunnelFollower();
        processSessions.shutdown();
        workspaceWatches.shutdown();
        reactiveCommands.shutdown();
        oauthProvider.close();
        durableOperations.close();
        runtimeEvents.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `Flyto2 Runtime listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(
      `trust proxy: ${config.logging.trustProxy ? "configured" : shouldTrustLocalPublicProxy(config) ? "loopback-public-proxy" : "disabled"}`,
    );
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("Flyto2 Runtime shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
