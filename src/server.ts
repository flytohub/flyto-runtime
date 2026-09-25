import { LEGACY_SHELL_HEADER, normalizeLegacyMcpInput } from "./mcp-legacy-input.js";
import { translateLegacyCodexWrite } from "./mcp-legacy-codex-writes.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, relative as relativePath } from "node:path";
import { flyto2RuntimePackageRoot } from "./flyto2/macos-launcher.js";
import { FLYTO2_RUNTIME_DOWNLOADS_URL, packagedDistribution } from "./flyto2/distribution.js";
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
import express from "express";
import type { Request, Response } from "express";
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
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  compileMcpRegistrationSurface,
  createModernMcpServerAdapter,
  modernMcpAdapterErrorLogFields,
  type McpRegistrationTarget,
} from "./mcp-modern-server.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { DEVSPACE_VERSION } from "./version.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { DurableOperationStore, runDurableOperation } from "./flyto2/durable-operations.js";
import { withDurableToolHandlers } from "./flyto2/durable-tools.js";
import { registerRuntimeTools } from "./flyto2/runtime-tools.js";
import { RuntimeEventStore } from "./flyto2/runtime-events.js";
import { ReactiveCommandRunner } from "./flyto2/reactive-command.js";
import { emitDurableToolEvent } from "./flyto2/tool-events.js";
import { WorkspaceWatchRegistry } from "./flyto2/workspace-watch.js";
import { WorkspaceRegistry } from "./workspaces.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import {
  toolNames,
  type ToolSurface,
} from "./tool-surfaces/types.js";
import {
  allowedRootsSentence,
  registerWorkspaceTools,
} from "./mcp-workspace-tools.js";
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
    ? " For a command that returns running=true, continue its session_id with write_stdin only after its retry_after_ms hint. Do not rerun the original command or busy-poll while that process session is available."
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
  if (packagedDistribution()) {
    return ` Only when the user asks to update Flyto2 Runtime itself, tell them to install the new version of the app from ${FLYTO2_RUNTIME_DOWNLOADS_URL}.`;
  }
  const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(flyto2RuntimePackageRoot(), "dist", "cli.js"))}`;
  return ` Only when the user asks to update Flyto2 Runtime itself, run \`${cli} service self-update\` and later \`${cli} service self-update status\`; the connection drops for a few seconds while it restarts, then retry.`;
}

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

  registerWorkspaceTools({
    server: registrationTarget,
    config,
    workspaces,
    reviewCheckpoints,
    resolveLocalAgentProviders,
  });

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

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
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
