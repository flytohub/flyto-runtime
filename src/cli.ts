#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import type { Result as BetterResult } from "better-result";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
} from "./local-agent-catalog.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import {
  parseLocalAgentContinueArgs,
  parseLocalAgentRunArgs,
} from "./local-agent-targets.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import { toAgentErrorPayload, type LocalAgentError } from "./local-agent-errors.js";
import {
  formatAgentCommandError,
  formatAgentObservation,
  formatAgentReceipt,
  formatAgentSummary,
  formatAgentTargetCatalog,
  presentAgentObservation,
  presentAgentReceipt,
  presentAgentSummary,
  presentAgentTargetCatalog,
} from "./local-agent-presentation.js";
import {
  type OnboardingDestination,
  ONBOARDING_CLIENT_OPTIONS,
  clientConnectionInstructions,
  SUBAGENT_SKILL_INSTALL_COMMAND,
  resolveOnboardingUsage,
  updateOnboardingSubagentsConfig,
  usesChatGpt,
  usesCodingAgents,
} from "./onboarding.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  setDevspaceConfigValue,
  setDevspaceConfigValues,
  writeDevspaceAuth,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { readReviewRef } from "./review-checkpoints.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { logEvent } from "./logger.js";
import { pruneStaleManagedWorktrees } from "./worktree-prune.js";
import { Flyto2CloudBridge } from "./flyto2/cloud-bridge.js";
import { runtimeManifest } from "./flyto2/manifest.js";

type Command =
  | "serve"
  | "init"
  | "doctor"
  | "config"
  | "worktrees"
  | "agents"
  | "show-changes"
  | "flyto2"
  | "menu"
  | "launcher"
  | "service"
  | "help"
  | "version";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=22.19 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "worktrees":
      await runWorktreesCommand(args);
      return;
    case "agents":
      await runAgentsCommand(args);
      return;
    case "show-changes":
      await runShowChanges(args);
      return;
    case "flyto2":
      await runFlyto2Command(args);
      return;
    case "menu":
      await runInteractiveMenu();
      return;
    case "launcher":
      await runLauncherCommand(args);
      return;
    case "service":
      await runServiceCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (
    command === "init"
    || command === "doctor"
    || command === "config"
    || command === "worktrees"
    || command === "agents"
    || command === "show-changes"
    || command === "flyto2"
    || command === "menu"
    || command === "launcher"
    || command === "service"
  ) return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.migratedLegacyConfig) {
    console.log(`Migrated legacy configuration to ${files.configPath}`);
  }
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "DevSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  devspace init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`DevSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `devspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("Flyto2 Runtime setup");

    const destinationAnswer = await prompts.multiselect({
      message: "Where do you want to use Flyto2 Runtime?",
      options: ONBOARDING_CLIENT_OPTIONS,
      initialValues: files.config.server.publicBaseUrl ? ["chatgpt"] : [],
      required: true,
    });
    if (prompts.isCancel(destinationAnswer)) throw new SetupCancelledError();
    const destinations = destinationAnswer as OnboardingDestination[];
    const usage = resolveOnboardingUsage(destinations);
    const useChatGpt = usesChatGpt(usage);
    const useCodingAgents = usesCodingAgents(usage);

    let allowedRoots: string[] | undefined;
    {
      const defaultRoots = files.config.workspaces.allowedRoots.join(", ") || process.cwd();
      const rootsAnswer = await textPrompt({
        message: `Which project folders can Flyto2 Runtime access? Press Enter to use ${defaultRoots}`,
        placeholder: defaultRoots,
        defaultValue: defaultRoots,
        validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
      });
      allowedRoots = rootsAnswer
        .split(",")
        .map((root) => resolve(expandHomePath(root.trim())))
        .filter(Boolean);
    }

    const port = files.config.server.port;

    let publicBaseUrl: string | null = null;
    if (useChatGpt) {
      prompts.note(
        [
          `Point your HTTPS tunnel or reverse proxy to http://127.0.0.1:${port}.`,
          "Paste its public URL below.",
          "",
          "Example: https://your-tunnel-host.example.com",
        ].join("\n"),
        "Connect ChatGPT",
      );
      publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
        message: files.config.server.publicBaseUrl
          ? `What public URL will ChatGPT connect to? Press Enter to keep ${files.config.server.publicBaseUrl}`
          : "What public URL will ChatGPT connect to?",
        placeholder: files.config.server.publicBaseUrl ?? "https://your-tunnel-host.example.com",
        defaultValue: files.config.server.publicBaseUrl ?? "",
        validate: validateRequiredPublicBaseUrl,
      }));
    }

    const currentSubagents = files.config.subagents;
    const availability = getLocalAgentProviderAvailabilitySnapshot(
      process.env,
      currentSubagents,
    );
    const configuredProviders = currentSubagents.providers
      .filter((provider) => provider.enabled)
      .map((provider) => provider.id);
    const initialValues = currentSubagents.enabled ? configuredProviders : [];
    prompts.log.info(
      "Client selection and optional local subagent providers are independent.",
    );
    const providerAnswer = await prompts.multiselect({
      message: "Optional: which local agents may Runtime use for delegated work?",
      options: availability.map((provider) => ({
        value: provider.name,
        label: provider.name,
        hint: provider.available
          ? provider.note ?? "available"
          : `unavailable: ${provider.reason ?? "provider preflight failed"}`,
      })),
      initialValues,
      required: false,
    });
    if (prompts.isCancel(providerAnswer)) throw new SetupCancelledError();
    const selectedProviders = providerAnswer as LocalAgentProvider[];
    const subagents = updateOnboardingSubagentsConfig(
      currentSubagents,
      selectedProviders,
    );

    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    setDevspaceConfigValues([
      { path: ["server", "port"], value: port },
      ...(useChatGpt
        ? [{ path: ["server", "publicBaseUrl"], value: publicBaseUrl }]
        : []),
      ...(allowedRoots
        ? [{ path: ["workspaces", "allowedRoots"], value: allowedRoots }]
        : []),
      { path: ["subagents"], value: subagents },
      ...(destinations.includes("codex")
        ? [{ path: ["tools", "mode"], value: "codex" }]
        : destinations.includes("claude") || useChatGpt
          ? [{ path: ["tools", "mode"], value: "claude" }]
          : []),
    ]);
    writeDevspaceAuth(auth);

    const lines = [
      ...(allowedRoots ? [`Project folders: ${allowedRoots.join(", ")}`] : []),
      `Subagents: ${selectedProviders.join(", ") || "disabled"}`,
      ...(publicBaseUrl ? [`ChatGPT connection URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "Flyto2 Runtime is ready");
    {
      prompts.note(
        [
          files.auth.ownerToken
            ? "Your existing Owner password is unchanged."
            : `Owner password: ${auth.ownerToken}`,
          "Use this to approve your MCP client in the Runtime OAuth page.",
        ].join("\n"),
        "Owner password",
      );
    }
    const connectionUrl = `${publicBaseUrl ?? files.config.server.publicBaseUrl ?? `http://127.0.0.1:${port}`}/mcp`;
    for (const destination of destinations) {
      prompts.note(clientConnectionInstructions(destination, connectionUrl), `Connect ${destination}`);
    }
    if (useCodingAgents && selectedProviders.length > 0) {
      prompts.note(
        [
          SUBAGENT_SKILL_INSTALL_COMMAND,
          "",
          "The Skills CLI will let you choose which Coding Agents receive it.",
        ].join("\n"),
        "Install the Subagents skill",
      );
    }
    const nextSteps = [
      "Choose Start Runtime in the launcher, or run `flyto2-runtime serve`, then authorize your MCP client.",
      useCodingAgents && selectedProviders.length > 0 ? "The Subagents skill is optional for local CLI delegation." : undefined,
    ].filter(Boolean).join(" ");
    prompts.outro(nextSteps);
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const config = loadConfig();
  // A Desktop launcher can be opened while the background Runtime is already serving.
  const localHost = ["0.0.0.0", "::"].includes(config.host) ? "127.0.0.1" : config.host;
  const localUrl = `http://${localHost.includes(":") ? `[${localHost}]` : localHost}:${config.port}`;
  try {
    const response = await fetch(`${localUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
    const health = await response.json() as { ok?: boolean; name?: string };
    if (health.ok && health.name === "flyto2-runtime") {
      console.log(`Flyto2 Runtime is already serving at ${localUrl}/mcp`);
      return;
    }
  } catch {
    // No healthy Runtime on the configured listener; start it below.
  }
  await runStartupWorktreeCleanup(config);
  const { createServer } = await import("./server.js");
  const { app, close, localAgentProviders } = createServer(config, {
    nativeTunnelWatchdog: true,
  });
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`Flyto2 Runtime listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because server.allowedHosts contains '*'");
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
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
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

async function runStartupWorktreeCleanup(config: ServerConfig): Promise<void> {
  try {
    const cleanup = await pruneStaleManagedWorktrees(config);
    if (cleanup.isErr()) {
      logEvent(config.logging, "warn", "managed_worktree_cleanup_failed", {
        error: cleanup.error.message,
        operation: cleanup.error.operation,
      });
      return;
    }

    const result = cleanup.value;
    const preserved = result.removed.filter((entry) => entry.recoveryRef).length;
    if (result.removed.length > 0 || result.missing.length > 0 || result.skipped.length > 0) {
      logEvent(config.logging, "info", "managed_worktree_cleanup", {
        removed: result.removed.length,
        recoveryRefs: preserved,
        missingSessions: result.missing.length,
        skippedUntracked: result.skipped.length,
      });
    }
    for (const failure of result.failed) {
      logEvent(config.logging, "warn", "managed_worktree_cleanup_failed", {
        workspaceId: failure.workspaceId,
        error: failure.error.message,
        operation: failure.error.operation,
      });
    }
  } catch (error) {
    logEvent(config.logging, "warn", "managed_worktree_cleanup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runDoctor(): Promise<void> {
  const files = loadDevspaceFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
    const providers = buildLocalAgentProviderStatuses(
      config.subagents,
      getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
    );
    console.log(`Subagents: ${config.subagents.enabled ? "enabled" : "disabled"}`);
    console.log(`Subagent providers: ${formatLocalAgentProviderStatusSummary(providers)}`);
    if (process.platform === "darwin") {
      const service = await import("./flyto2/macos-service.js");
      const runtimeService = service.macRuntimeServiceStatus();
      const legacyService = service.legacyMacKitStatus();
      console.log(
        `Background service: ${runtimeService.loaded ? "running" : runtimeService.installed ? "installed" : "not installed"} (${runtimeService.label})`,
      );
      console.log(
        `Legacy Mac Kit: service=${legacyService.serviceLoaded ? "loaded" : "stopped"}, updater=${legacyService.updaterLoaded ? "loaded" : "stopped"}`,
      );
    }
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `devspace config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  setDevspaceConfigValue(
    ["server", "publicBaseUrl"],
    normalizeOptionalPublicBaseUrl(value),
  );
  console.log(`Updated ${files.configPath}`);
}

async function runWorktreesCommand(args: string[]): Promise<void> {
  const [subcommand, ...extra] = args;
  if (subcommand !== "prune" || extra.length > 0) {
    throw new Error("Usage: devspace worktrees prune");
  }

  const cleanup = await pruneStaleManagedWorktrees(loadConfig());
  if (cleanup.isErr()) {
    console.warn(`Failed to prune managed worktrees: ${cleanup.error.message}`);
    process.exitCode = 1;
    return;
  }

  const result = cleanup.value;
  const preserved = result.removed.filter((entry) => entry.recoveryRef).length;
  console.log(`Pruned ${result.removed.length} stale managed worktree${result.removed.length === 1 ? "" : "s"}.`);
  if (preserved > 0) console.log(`Preserved ${preserved} recovery ref${preserved === 1 ? "" : "s"}.`);
  if (result.missing.length > 0) {
    console.log(`Cleared ${result.missing.length} missing worktree session${result.missing.length === 1 ? "" : "s"}.`);
  }
  if (result.skipped.length > 0) {
    console.log(`Skipped ${result.skipped.length} worktree${result.skipped.length === 1 ? "" : "s"} with untracked files.`);
  }
  for (const failure of result.failed) {
    console.warn(`Failed to prune ${failure.workspaceId}: ${failure.error.message}`);
  }
  if (result.failed.length > 0) process.exitCode = 1;
}

async function runServiceCommand(args: string[]): Promise<void> {
  const [subcommand = "status", ...rest] = args;
  const usage =
    "Usage: flyto2-runtime service <stage|install|start|stop|restart|status|update|rollback|uninstall|legacy-status|disable-legacy-updater|restore-legacy|tunnel-migrate|tunnel-start|tunnel-stop|tunnel-status>";
  if (rest.length > 0) throw new Error(usage);

  const service = await import("./flyto2/macos-service.js");
  const tunnel = await import("./flyto2/macos-tunnel.js");
  const startTunnelIfConfigured = () =>
    tunnel.loadNativeTunnelProfile()
      ? tunnel.startNativeTunnelService()
      : tunnel.nativeTunnelStatus();
  const stopTunnelIfConfigured = () =>
    tunnel.loadNativeTunnelProfile()
      ? tunnel.stopNativeTunnelService()
      : tunnel.nativeTunnelStatus();

  switch (subcommand) {
    case "stage": {
      const configDirectory = loadDevspaceFiles().dir;
      const profile = tunnel.loadNativeTunnelProfile()
        ?? tunnel.migrateLegacyCloudflareTunnel(configDirectory);
      const tunnelStatus = tunnel.installNativeTunnelService(undefined, false);
      const runtime = service.installMacRuntimeService({
        configDirectory,
        start: false,
      });
      console.log(JSON.stringify({
        runtime,
        tunnel: tunnelStatus,
        tunnel_profile: profile,
        legacy: service.legacyMacKitStatus(),
      }, null, 2));
      return;
    }
    case "install": {
      const runtime = service.installMacRuntimeService();
      const nativeTunnel = startTunnelIfConfigured();
      console.log(JSON.stringify({ runtime, tunnel: nativeTunnel }, null, 2));
      return;
    }
    case "start": {
      const runtime = service.startMacRuntimeService();
      const nativeTunnel = startTunnelIfConfigured();
      console.log(JSON.stringify({ runtime, tunnel: nativeTunnel }, null, 2));
      return;
    }
    case "stop": {
      const nativeTunnel = stopTunnelIfConfigured();
      const runtime = service.stopMacRuntimeService();
      console.log(JSON.stringify({ runtime, tunnel: nativeTunnel }, null, 2));
      return;
    }
    case "restart": {
      const runtime = service.restartMacRuntimeService();
      const nativeTunnel = startTunnelIfConfigured();
      console.log(JSON.stringify({ runtime, tunnel: nativeTunnel }, null, 2));
      return;
    }
    case "status":
      console.log(JSON.stringify({
        runtime: service.macRuntimeServiceStatus(),
        tunnel: tunnel.nativeTunnelStatus(),
        legacy: service.legacyMacKitStatus(),
      }, null, 2));
      return;
    case "update": {
      const updater = await import("./flyto2/github-release-updater.js");
      const release = await updater.installLatestFlyto2Release();
      const runtime = service.installMacRuntimeService({
        packageRoot: release.package_root,
        configDirectory: loadDevspaceFiles().dir,
        start: false,
      });
      console.log(JSON.stringify({
        runtime,
        release,
        update_source: "https://github.com/flytohub/flyto-runtime/releases/latest",
        staged: true,
        activation_command: "flyto2-runtime service restart",
      }, null, 2));
      return;
    }
    case "rollback":
      console.log(JSON.stringify(service.rollbackMacRuntimeService(), null, 2));
      return;
    case "uninstall": {
      const nativeTunnel = stopTunnelIfConfigured();
      const runtime = service.uninstallMacRuntimeService();
      console.log(JSON.stringify({ runtime, tunnel: nativeTunnel }, null, 2));
      return;
    }
    case "legacy-status":
      console.log(JSON.stringify(service.legacyMacKitStatus(), null, 2));
      return;
    case "disable-legacy-updater":
      console.log(JSON.stringify(service.stopLegacyMacKitUpdater(), null, 2));
      return;
    case "restore-legacy":
      console.log(JSON.stringify(service.restoreLegacyMacKit(), null, 2));
      return;
    case "tunnel-migrate": {
      const profile = tunnel.migrateLegacyCloudflareTunnel(
        loadDevspaceFiles().dir,
      );
      const status = tunnel.installNativeTunnelService(undefined, false);
      console.log(JSON.stringify({ profile, status }, null, 2));
      return;
    }
    case "tunnel-start":
      console.log(JSON.stringify(tunnel.startNativeTunnelService(), null, 2));
      return;
    case "tunnel-stop":
      console.log(JSON.stringify(tunnel.stopNativeTunnelService(), null, 2));
      return;
    case "tunnel-status":
      console.log(JSON.stringify(tunnel.nativeTunnelStatus(), null, 2));
      return;
    default:
      throw new Error(usage);
  }
}

async function runLauncherCommand(args: string[]): Promise<void> {
  const [subcommand = "status", ...rest] = args;
  if (rest.length > 0) {
    throw new Error("Usage: flyto2-runtime launcher <install|status|remove>");
  }

  const {
    installMacDesktopLaunchers,
    macDesktopLauncherStatus,
    removeMacDesktopLaunchers,
  } = await import("./flyto2/macos-launcher.js");

  switch (subcommand) {
    case "install": {
      const installed = installMacDesktopLaunchers();
      console.log(JSON.stringify({ ok: true, ...installed }, null, 2));
      return;
    }
    case "status":
      console.log(JSON.stringify(macDesktopLauncherStatus(), null, 2));
      return;
    case "remove": {
      const directory = removeMacDesktopLaunchers();
      console.log(JSON.stringify({ ok: true, removed: directory }, null, 2));
      return;
    }
    default:
      throw new Error("Usage: flyto2-runtime launcher <install|status|remove>");
  }
}

async function runInteractiveMenu(): Promise<void> {
  prompts.intro("Flyto2 Runtime");

  for (;;) {
    const action = await prompts.select({
      message: "Choose an action",
      options: [
        { value: "start", label: "Start Runtime", hint: "Start the MCP server" },
        { value: "status", label: "Runtime / Cloud status" },
        { value: "doctor", label: "Doctor", hint: "Check config and native dependencies" },
        { value: "manifest", label: "Capability manifest" },
        { value: "pair", label: "Pair with Flyto2 Cloud" },
        { value: "setup", label: "Setup / choose client", hint: "Codex, ChatGPT, Claude, or custom MCP" },
        { value: "launcher", label: "Install Desktop launcher" },
        { value: "quit", label: "Quit" },
      ],
    });

    if (prompts.isCancel(action) || action === "quit") {
      prompts.outro("Flyto2 Runtime closed.");
      return;
    }

    switch (action) {
      case "start":
        await ensureConfigured();
        if (process.platform === "darwin") {
          await runServiceCommand(["start"]);
          prompts.outro("Flyto2 Runtime background service is running.");
          return;
        }
        prompts.outro("Starting Flyto2 Runtime.");
        await serve();
        return;
      case "status":
        await ensureConfigured();
        await runFlyto2Command(["status"]);
        break;
      case "doctor":
        await runDoctor();
        break;
      case "manifest":
        await ensureConfigured();
        await runFlyto2Command(["manifest"]);
        break;
      case "pair": {
        await ensureConfigured();
        const pairingCode = await textPrompt({
          message: "Flyto2 Cloud pairing code",
          placeholder: "XXXX-XXXX",
          defaultValue: "",
          validate: (value) => value?.trim() ? undefined : "Enter the pairing code.",
        });
        const cloudUrl = await textPrompt({
          message: "Flyto2 Cloud URL",
          placeholder: "https://api.flyto2.com",
          defaultValue: "https://api.flyto2.com",
          validate: (value) => value ? validatePublicBaseUrl(value) : undefined,
        });
        await runFlyto2Command(["pair", pairingCode, "--cloud-url", cloudUrl]);
        break;
      }
      case "setup":
        await runInit({ force: true });
        break;
      case "launcher": {
        const { installMacDesktopLaunchers } = await import("./flyto2/macos-launcher.js");
        const installed = installMacDesktopLaunchers(process.cwd());
        prompts.log.success("Desktop launchers installed at " + installed.directory);
        break;
      }
    }
  }
}

async function runFlyto2Command(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const config = loadConfig();
  const manifest = runtimeManifest(config);
  const bridge = new Flyto2CloudBridge(config);

  switch (subcommand) {
    case "manifest":
    case undefined:
      if (rest.length > 0) throw new Error("Usage: flyto2-runtime flyto2 manifest");
      console.log(JSON.stringify(manifest, null, 2));
      return;
    case "status":
      if (rest.length > 0) throw new Error("Usage: flyto2-runtime flyto2 status");
      console.log(JSON.stringify({
        product: "Flyto2",
        runtime: "flyto-runtime",
        runtime_id: manifest.runtime_id,
        paired: bridge.paired,
        device_id: bridge.deviceId,
        workspace_id: bridge.workspaceId,
      }, null, 2));
      return;
    case "pair": {
      const cloudIndex = rest.indexOf("--cloud-url");
      const cloudUrl = cloudIndex >= 0 ? rest[cloudIndex + 1] : undefined;
      const pairingCode = rest[0];
      if (!pairingCode || (cloudIndex >= 0 && !cloudUrl)) {
        throw new Error(
          "Usage: flyto2-runtime flyto2 pair <pairing-code> [--cloud-url https://api.flyto2.com]",
        );
      }
      const credentials = await bridge.pair(pairingCode, manifest, cloudUrl);
      console.log(JSON.stringify({
        ok: true,
        device_id: credentials.device_id,
        workspace_id: credentials.workspace_id,
        workspace_name: credentials.workspace_name,
        cloud_url: credentials.cloud_url,
      }, null, 2));
      return;
    }
    case "next": {
      if (rest.length > 0) throw new Error("Usage: flyto2-runtime flyto2 next");
      const assignment = await bridge.waitForAssignment();
      console.log(JSON.stringify({ assignment: assignment ?? null }, null, 2));
      return;
    }
    default:
      throw new Error(
        "Usage: flyto2-runtime flyto2 <manifest|status|pair|next>",
      );
  }
}

function printHelp(): void {
  console.log(
    [
      "Flyto2 Runtime",
      "",
      "Usage:",
      "  flyto2-runtime           Run first-time setup if needed, then start the server",
      "  devspace                 Compatibility alias for flyto2-runtime",
      "  devspace serve           Start the server",
      "  devspace init            Create or update ~/.devspace/config.jsonc and auth.json",
      "  devspace doctor          Show config, runtime, and native dependency status",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "  devspace worktrees prune Prune managed worktrees unused for 3 days",
      "  devspace show-changes <review-ref> [--json]",
      "  flyto2-runtime flyto2 manifest",
      "  flyto2-runtime flyto2 status",
      "  flyto2-runtime flyto2 pair <pairing-code> [--cloud-url https://api.flyto2.com]",
      "  flyto2-runtime flyto2 next   Wait for one Cloud assignment without executing it",
      "  flyto2-runtime menu          Open the interactive Flyto2 Runtime launcher",
      "  flyto2-runtime launcher install|status|remove",
      "  flyto2-runtime service install|start|stop|restart|status|update|rollback|uninstall",
      "  devspace agents targets [--json]  List usable subagent providers and profiles",
      "  devspace agents ls       List subagent sessions",
      "  devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] <prompt>",
      "  devspace agents continue <id> [--model <model>] [--effort <level>] <prompt>",
      "  devspace agents show <id> [--json]",
      "  devspace agents wait <id>... [--timeout <seconds>] [--json]",
      "  devspace agents daemon <status|stop|logs>",
      "  devspace -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  devspace config set publicBaseUrl https://example.trycloudflare.com",
      "  devspace serve",
    ].join("\n"),
  );
}

async function runShowChanges(args: string[]): Promise<void> {
  const { args: commandArgs, json } = extractJsonOption(args);
  const [reviewRef, ...extra] = commandArgs;
  if (!reviewRef || extra.length > 0) {
    throw new Error("Usage: devspace show-changes <review-ref> [--json]");
  }

  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const review = await readReviewRef(scope.workspaceRoot, reviewRef);
  if (json) {
    printJson(review);
    return;
  }
  console.log(review.patch || review.result);
}

async function runAgentsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const { args: commandArgs, json } = extractJsonOption(rest);
  switch (subcommand) {
    case "ls":
    case "list":
      await runAgentWorkflowCommand(json, () => runAgentsList(commandArgs, json));
      return;
    case "run":
      await runAgentWorkflowCommand(json, () => runAgentsRun(commandArgs, json));
      return;
    case "continue":
      await runAgentWorkflowCommand(json, () => runAgentsContinue(commandArgs, json));
      return;
    case "show":
      await runAgentWorkflowCommand(json, () => runAgentsShow(commandArgs, json));
      return;
    case "wait":
      await runAgentWorkflowCommand(json, () => runAgentsWait(commandArgs, json));
      return;
    case "targets":
      await runAgentWorkflowCommand(json, () => runAgentsTargets(commandArgs, json));
      return;
    case "daemon":
      await runAgentsDaemon(commandArgs, json);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentsHelp();
      return;
    default:
      writeAgentWorkflowError(`Unknown agents command: ${subcommand}`, json);
  }
}

async function runAgentsTargets(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: devspace agents targets [--json]");
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const profiles = await loadLocalAgentProfiles(config, scope.workspaceRoot);
  const providers = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
  );
  const catalog = buildLocalAgentCatalog(config.subagents, profiles, providers);
  const output = presentAgentTargetCatalog(catalog);
  if (json) printJson(output);
  else printAgentXml(formatAgentTargetCatalog(output));
}

async function runAgentsList(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: devspace agents ls [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const result = await client.list(resolveCliWorkspaceContext(config.allowedRoots));
  const agents = presentAgentWorkflowResult(result, json);
  if (!agents) return;

  const summaries = agents.map(presentAgentSummary);
  if (json) {
    printJson(summaries);
    return;
  }

  printAgentXml(summaries.map(formatAgentSummary).join("\n"));
}

async function runAgentsRun(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentRunArgs(args);
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const client = createLocalAgentClient(config);
  const result = await client.start({
    target: parsed.target,
    prompt: parsed.prompt,
    workspaceRoot: scope.workspaceRoot,
    workspaceId: scope.workspaceId,
    model: parsed.model,
    effort: parsed.effort,
  });
  const record = presentAgentWorkflowResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  printAgentXml(formatAgentReceipt(receipt));
}

async function runAgentsContinue(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentContinueArgs(args);
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const result = await client.continue(parsed.agentId, parsed.prompt, {
    model: parsed.model,
    effort: parsed.effort,
  }, scope);
  const record = presentAgentWorkflowResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  printAgentXml(formatAgentReceipt(receipt));
}

async function runAgentsShow(args: string[], json: boolean): Promise<void> {
  const [id, ...extra] = args;
  if (!id || extra.length > 0) throw new Error("Usage: devspace agents show <id> [--json]");

  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const initial = await client.get(id, scope);
  const record = presentAgentWorkflowResult(initial, json);
  if (!record) return;

  const observation = presentAgentObservation(record);
  if (json) printJson(observation);
  else printAgentXml(formatAgentObservation(observation));
}

async function runAgentsWait(args: string[], json: boolean): Promise<void> {
  const { ids, timeoutMs } = parseAgentsWaitArgs(args);
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const results = presentAgentWorkflowResult(await client.wait(ids, scope, timeoutMs), json);
  if (!results) return;
  if (json) {
    printJson(results);
    return;
  }
  printAgentXml(results.map(formatAgentObservation).join("\n"));
}

function parseAgentsWaitArgs(args: string[]): { ids: string[]; timeoutMs?: number } {
  const ids: string[] = [];
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--timeout") {
      timeoutMs = parseAgentWaitTimeout(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("--timeout=")) {
      timeoutMs = parseAgentWaitTimeout(argument.slice("--timeout=".length));
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}.`);
    ids.push(argument);
  }
  if (ids.length === 0) {
    throw new Error("Usage: devspace agents wait <id>... [--timeout <seconds>] [--json]");
  }
  return { ids, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function parseAgentWaitTimeout(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error("Agent wait timeout must be a non-negative integer number of seconds.");
  }
  const timeoutMs = Number(value) * 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647) {
    throw new Error("Agent wait timeout is too large.");
  }
  return timeoutMs;
}

async function runAgentsDaemon(args: string[], json: boolean): Promise<void> {
  const [subcommand, ...extra] = args;
  if (extra.length > 0) throw new Error("Usage: devspace agents daemon <status|stop|logs> [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  switch (subcommand) {
    case "status": {
      const status = presentAgentResult(await client.status(), json);
      if (!status) return;
      printJson(status);
      return;
    }
    case "stop": {
      const status = presentAgentResult(await client.stop(), json);
      if (!status) return;
      if (json) printJson(status);
      else console.log("Local agent daemon stop requested.");
      return;
    }
    case "logs": {
      const logs = presentAgentResult(await client.logs(), json);
      if (logs === undefined) return;
      if (json) printJson({ logs });
      else console.log(logs || "No local agent daemon logs found.");
      return;
    }
    default:
      throw new Error("Usage: devspace agents daemon <status|stop|logs>");
  }
}

function extractJsonOption(args: string[]): { args: string[]; json: boolean } {
  const commandArgs: string[] = [];
  let json = false;
  let optionsEnded = false;
  for (const argument of args) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      commandArgs.push(argument);
      continue;
    }
    if (!optionsEnded && argument === "--json") {
      json = true;
      continue;
    }
    commandArgs.push(argument);
  }
  return { args: commandArgs, json };
}

function presentAgentResult<T, E extends LocalAgentError>(
  result: BetterResult<T, E>,
  json: boolean,
): T | undefined {
  if (result.isOk()) return result.value;
  if (json) {
    printJson({ error: toAgentErrorPayload(result.error) });
    process.exitCode = 1;
    return undefined;
  }
  throw new Error(result.error.message);
}

function presentAgentWorkflowResult<T, E extends LocalAgentError>(
  result: BetterResult<T, E>,
  json: boolean,
): T | undefined {
  if (result.isOk()) return result.value;
  const error = toAgentErrorPayload(result.error);
  if (json) printJson({ error });
  else console.error(formatAgentCommandError(error));
  process.exitCode = 1;
  return undefined;
}

async function runAgentWorkflowCommand(json: boolean, command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    writeAgentWorkflowError(error instanceof Error ? error.message : String(error), json);
  }
}

function writeAgentWorkflowError(message: string, json: boolean): void {
  const error = { code: "AGENT_COMMAND_ERROR", message, retryable: false };
  if (json) printJson({ error });
  else console.error(formatAgentCommandError(error));
  process.exitCode = 1;
}

function printAgentXml(fragment: string): void {
  if (fragment) console.log(fragment);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function printAgentsHelp(): void {
  console.log(
    [
      "DevSpace agents",
      "",
      "Usage:",
      "  devspace agents ls [--json]",
      "  devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  devspace agents continue <id> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  devspace agents show <id> [--json]",
      "  devspace agents wait <id>... [--timeout <seconds>] [--json]",
      "  devspace agents targets [--json]",
      "  devspace agents daemon <status|stop|logs> [--json]",
    ].join("\n"),
  );
}

function printVersion(): void {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read DevSpace package version.");
  }

  console.log(packageJson.version);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
