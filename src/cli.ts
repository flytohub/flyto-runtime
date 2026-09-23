#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
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
  resolveToolModeForDestinations,
  suggestedProjectRoots,
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
import {
  collectSetupStatus,
  connectionDetailsClipboardText,
  copyToClipboard,
  formatConnectionDetails,
  formatSetupStatus,
  setupIsConnectable,
  describeServiceState,
  nativeServiceState,
  probeRuntimeHealth,
  type SetupConnectionDetails,
  waitForRuntimeHealth,
} from "./setup-completion.js";
import {
  DEFAULT_PLUGIN_DESCRIPTION,
  DEFAULT_PLUGIN_DISPLAY_NAME,
  DEFAULT_PLUGIN_NAME,
  mcpUrlFromPublicBaseUrl,
  writePortablePluginPackage,
} from "./portable-plugin.js";

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
  | "plugin"
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
    case "plugin":
      await runPluginCommand(args);
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
    || command === "plugin"
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

  await runInit({ force: false, exitLabel: "Continue" });
}

async function runInit({
  force,
  exitLabel = "Done",
}: {
  force: boolean;
  exitLabel?: string;
}): Promise<void> {
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
    const toolMode = resolveToolModeForDestinations(destinations);
    const useChatGpt = usesChatGpt(usage);
    const useCodingAgents = usesCodingAgents(usage);

    let allowedRoots: string[] | undefined;
    {
      const defaultRoots = suggestedProjectRoots({
        configuredRoots: files.config.workspaces.allowedRoots,
        cwd: process.cwd(),
        homeDirectory: homedir(),
        runtimePackageRoot: fileURLToPath(new URL("..", import.meta.url)),
      });
      const rootsAnswer = await textPrompt({
        message: defaultRoots
          ? `Which project folders can Flyto2 Runtime access? Press Enter to use ${defaultRoots}`
          : "Which project folders can Flyto2 Runtime access? Separate several with commas.",
        placeholder: defaultRoots || "~/Projects",
        defaultValue: defaultRoots,
        validate: (value) => value?.trim() || defaultRoots ? undefined : "Enter at least one project folder.",
      });
      allowedRoots = rootsAnswer
        .split(",")
        .map((root) => resolve(expandHomePath(root.trim())))
        .filter(Boolean);
    }

    const port = files.config.server.port;

    let publicBaseUrl: string | null = null;
    let generateChatGptPlugin = false;
    if (useChatGpt) {
      publicBaseUrl = await chooseChatGptPublicUrl(port, files.config.server.publicBaseUrl);

      const pluginAnswer = await prompts.confirm({
        message: "Generate an upload-ready ChatGPT Plugin ZIP now?",
      });
      if (prompts.isCancel(pluginAnswer)) throw new SetupCancelledError();
      generateChatGptPlugin = pluginAnswer;
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
      ...(toolMode
        ? [{ path: ["tools", "mode"], value: toolMode }]
        : []),
    ]);
    writeDevspaceAuth(auth);

    let chatGptPluginPath: string | undefined;
    if (useChatGpt && publicBaseUrl && generateChatGptPlugin) {
      const packageJson = require("../package.json") as { version?: unknown };
      const plugin = await writePortablePluginPackage({
        mcpUrl: mcpUrlFromPublicBaseUrl(publicBaseUrl),
        version: typeof packageJson.version === "string" ? packageJson.version : "1.0.0",
      });
      chatGptPluginPath = plugin.outputPath;
    }

    const lines = [
      ...(allowedRoots ? [`Project folders: ${allowedRoots.join(", ")}`] : []),
      `Subagents: ${selectedProviders.join(", ") || "disabled"}`,
      ...(publicBaseUrl ? [`ChatGPT connection URL: ${publicBaseUrl}/mcp`] : []),
      ...(chatGptPluginPath ? [`ChatGPT plugin ZIP: ${chatGptPluginPath}`] : []),
    ];
    prompts.note(lines.join("\n"), "Flyto2 Runtime configuration saved");
    const connectionUrl = `${publicBaseUrl ?? files.config.server.publicBaseUrl ?? `http://127.0.0.1:${port}`}/mcp`;
    for (const destination of destinations) {
      if (destination === "chatgpt" && chatGptPluginPath) {
        prompts.note(
          [
            `Upload ${chatGptPluginPath} in ChatGPT Plugins.`,
            `The package points to ${connectionUrl}.`,
            "Authorize the MCP connection with your Owner password when ChatGPT asks.",
          ].join("\n"),
          "Connect chatgpt",
        );
        continue;
      }
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
    await showSetupCompletion({
      localBaseUrl: `http://127.0.0.1:${port}`,
      publicBaseUrl: publicBaseUrl ?? files.config.server.publicBaseUrl ?? null,
      details: {
        mcpUrl: connectionUrl,
        ownerPassword: auth.ownerToken,
        pluginPath: chatGptPluginPath,
      },
      revealPassword: !files.auth.ownerToken,
      exitLabel,
    });
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

// ChatGPT needs a public HTTPS URL. A first-time user usually has neither a
// domain nor a tunnel, so the default is a free Cloudflare quick tunnel that
// Setup creates and keeps running; users with their own URL can still paste it.
async function chooseChatGptPublicUrl(port: number, savedUrl: string | null): Promise<string> {
  const quick = await import("./flyto2/quick-tunnel-service.js");
  const serviceManaged = process.platform === "darwin" || process.platform === "win32";
  const savedIsQuick = savedUrl ? /\.trycloudflare\.com$/.test(new URL(savedUrl).hostname) : false;
  const choice = serviceManaged
    ? await prompts.select<"quick" | "own">({
        message: "How should ChatGPT reach this computer?",
        initialValue: savedUrl && !savedIsQuick ? "own" : "quick",
        options: [
          { value: "quick", label: "Create a free Cloudflare URL for me", hint: "No account or domain needed; the URL changes if the tunnel restarts" },
          { value: "own", label: "Use my own HTTPS URL", hint: "A named Cloudflare tunnel, reverse proxy, Tailscale Funnel or ngrok domain" },
        ],
      })
    : "own";
  if (prompts.isCancel(choice)) throw new SetupCancelledError();

  if (choice === "quick") {
    const created = await createQuickTunnelInSetup(quick, port);
    if (created) return created;
    prompts.log.warn("Continuing with your own URL instead.");
  }
  // A running quick tunnel would make Runtime replace the URL chosen here.
  if ((await quick.quickTunnelStatus()).configured) await quick.stopQuickTunnel();

  prompts.note(
    [
      `Point your HTTPS tunnel or reverse proxy to http://127.0.0.1:${port}.`,
      "Paste its public URL below.",
      "",
      "Example: https://your-tunnel-host.example.com",
    ].join("\n"),
    "Connect ChatGPT",
  );
  return normalizePublicBaseUrl(await textPrompt({
    message: savedUrl && !savedIsQuick
      ? `What public URL will ChatGPT connect to? Press Enter to keep ${savedUrl}`
      : "What public URL will ChatGPT connect to?",
    placeholder: savedUrl && !savedIsQuick ? savedUrl : "https://your-tunnel-host.example.com",
    defaultValue: savedUrl && !savedIsQuick ? savedUrl : "",
    validate: validateRequiredPublicBaseUrl,
  }));
}

async function createQuickTunnelInSetup(
  quick: typeof import("./flyto2/quick-tunnel-service.js"),
  port: number,
): Promise<string | undefined> {
  let binaryPath = quick.findCloudflared();
  if (!binaryPath) {
    const { cloudflaredInstallCommand } = await import("./flyto2/quick-tunnel.js");
    const install = cloudflaredInstallCommand(process.platform, quick.commandExists);
    if (!install) {
      prompts.log.warn(
        process.platform === "win32"
          ? "cloudflared is not installed and winget is unavailable. Install cloudflared from https://github.com/cloudflare/cloudflared/releases and run setup again."
          : "cloudflared is not installed and Homebrew is unavailable. Install cloudflared from https://github.com/cloudflare/cloudflared/releases and run setup again.",
      );
      return undefined;
    }
    const approved = await prompts.confirm({
      message: `cloudflared is required. Install it now with \`${[install.command, ...install.args.slice(0, 3)].join(" ")}\`?`,
    });
    if (prompts.isCancel(approved)) throw new SetupCancelledError();
    if (!approved) return undefined;
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(install.command, install.args, { stdio: "inherit", windowsHide: true });
    binaryPath = quick.findCloudflared();
    if (result.status !== 0 || !binaryPath) {
      prompts.log.warn("cloudflared could not be installed.");
      return undefined;
    }
  }

  const spinner = prompts.spinner();
  spinner.start("Creating a free Cloudflare URL");
  try {
    const status = await quick.startQuickTunnel({ binaryPath, originPort: port });
    spinner.stop(`Public URL: ${status.public_base_url}`);
    prompts.note(
      [
        "This free URL stays the same until the tunnel restarts (for example after a reboot).",
        "Runtime follows the new URL on its own; give ChatGPT the new URL when that happens.",
        "`flyto2-runtime doctor` always shows the current one.",
        "For a URL that never changes, use a named Cloudflare tunnel with your own domain.",
      ].join("\n"),
      "Free Cloudflare URL",
    );
    return status.public_base_url;
  } catch (error) {
    spinner.stop(`Could not create the free URL: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

interface SetupCompletionOptions {
  localBaseUrl: string;
  publicBaseUrl: string | null;
  details: SetupConnectionDetails;
  revealPassword: boolean;
  exitLabel: string;
}

type SetupCompletionAction =
  | "copy_all"
  | "copy_url"
  | "copy_password"
  | "toggle_password"
  | "start"
  | "restart"
  | "recheck"
  | "exit";

// Setup ends on a screen that proves the Runtime is connectable and keeps the
// connection details in one place until the user chooses to leave.
async function showSetupCompletion(options: SetupCompletionOptions): Promise<void> {
  const service = await import("./flyto2/native-service.js");
  const serviceSupported = service.nativeServiceSupported();
  const probe = () => collectSetupStatus({
    localBaseUrl: options.localBaseUrl,
    publicBaseUrl: options.publicBaseUrl,
    serviceStatus: serviceSupported ? () => service.nativeRuntimeServiceStatus() : undefined,
  });
  let revealPassword = options.revealPassword;
  let status = await probe();
  // A Runtime that was already serving still holds the configuration from
  // before this setup; it serves the new tool mode and URL only after a restart.
  let restartPending = status.local === "ok";

  for (;;) {
    const connectable = setupIsConnectable(status);
    prompts.note(
      [
        ...formatSetupStatus(status),
        "",
        ...formatConnectionDetails(options.details, { revealPassword }),
        "",
        "Approve your MCP client with the Owner password on the Runtime OAuth page.",
        ...(restartPending && status.local === "ok"
          ? ["Restart the Runtime so it serves the settings you just saved."]
          : []),
        ...(status.local === "foreign"
          ? [`Another program answers on ${options.localBaseUrl}. Stop it (check \`flyto2-runtime service legacy-status\`), then choose Start Runtime.`]
          : []),
        ...(status.local !== "unreachable" || serviceSupported
          ? []
          : ["Run `flyto2-runtime serve` in another terminal, then choose Check again."]),
      ].join("\n"),
      connectable ? "Setup complete" : "Setup saved - Runtime is not connectable yet",
    );

    const runtimeAction: { value: SetupCompletionAction; label: string } | undefined = !serviceSupported
      ? undefined
      : status.local === "ok"
        ? { value: "restart", label: "Restart Runtime" }
        : { value: "start", label: "Start Runtime" };
    const action = await prompts.select<SetupCompletionAction>({
      message: "What would you like to do?",
      initialValue: connectable && !restartPending
        ? "copy_all"
        : status.local === "foreign" ? "recheck" : runtimeAction?.value ?? "recheck",
      options: [
        { value: "copy_all", label: "Copy all connection details" },
        { value: "copy_url", label: "Copy MCP URL" },
        { value: "copy_password", label: "Copy Owner password" },
        { value: "toggle_password", label: revealPassword ? "Hide Owner password" : "Reveal Owner password" },
        ...(runtimeAction ? [runtimeAction] : []),
        { value: "recheck", label: "Check again" },
        { value: "exit", label: options.exitLabel },
      ],
    });
    if (prompts.isCancel(action) || action === "exit") return;

    switch (action) {
      case "copy_all":
      case "copy_url":
      case "copy_password": {
        const [text, what] = action === "copy_all"
          ? [connectionDetailsClipboardText(options.details), "Connection details"]
          : action === "copy_url"
            ? [options.details.mcpUrl, "MCP URL"]
            : [options.details.ownerPassword, "Owner password"];
        if (await copyToClipboard(text)) prompts.log.success(`${what} copied to the clipboard.`);
        else prompts.log.warn("No clipboard tool is available here. Reveal the Owner password and copy it manually.");
        break;
      }
      case "toggle_password":
        revealPassword = !revealPassword;
        break;
      case "start":
      case "restart": {
        const spinner = prompts.spinner();
        spinner.start(action === "start" ? "Starting Flyto2 Runtime" : "Restarting Flyto2 Runtime");
        try {
          if (action === "start") service.startNativeRuntimeService();
          else service.restartNativeRuntimeService();
          status = await waitForRuntimeHealth(probe);
          if (status.local === "ok") restartPending = false;
          spinner.stop(status.local === "ok" ? "Flyto2 Runtime is running." : "Flyto2 Runtime did not pass its health check.");
        } catch (error) {
          spinner.stop(`Could not ${action} Flyto2 Runtime: ${error instanceof Error ? error.message : String(error)}`);
          status = await probe();
        }
        continue;
      }
      case "recheck":
        break;
    }
    status = await probe();
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
  // Managed service processes skip this probe: during a launchd/Task Scheduler
  // handoff the previous process can remain healthy for a few milliseconds,
  // which would make the replacement process incorrectly exit before binding.
  const localHost = ["0.0.0.0", "::"].includes(config.host) ? "127.0.0.1" : config.host;
  const localUrl = `http://${localHost.includes(":") ? `[${localHost}]` : localHost}:${config.port}`;
  if (process.env.FLYTO2_RUNTIME_MANAGED_SERVICE !== "1") {
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
    const localHost = ["0.0.0.0", "::"].includes(config.host) ? "127.0.0.1" : config.host;
    const localHealth = await probeRuntimeHealth(
      `http://${localHost.includes(":") ? `[${localHost}]` : localHost}:${config.port}/healthz`,
    );
    console.log(`Local Runtime health: ${{
      ok: "ok",
      foreign: "another program answers on this port, not Flyto2 Runtime",
      unreachable: "unreachable",
      not_configured: "not configured",
    }[localHealth]}`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    const quickTunnel = await (await import("./flyto2/quick-tunnel-service.js")).quickTunnelStatus();
    if (quickTunnel.configured) {
      console.log(
        `Quick tunnel: ${quickTunnel.running ? `running at ${quickTunnel.public_base_url} (a free URL that changes when the tunnel restarts)` : "configured but not reporting a URL"}`,
      );
    }
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
    console.log(`Tool mode: ${config.toolMode}`);
    console.log(
      `Runtime internals: ${config.exposeRuntimeInternals ? "exposed for diagnostics" : "hidden"}`,
    );
    const providers = buildLocalAgentProviderStatuses(
      config.subagents,
      getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
    );
    console.log(`Subagents: ${config.subagents.enabled ? "enabled" : "disabled"}`);
    console.log(`Subagent providers: ${formatLocalAgentProviderStatusSummary(providers)}`);
    if (process.platform === "darwin" || process.platform === "win32") {
      const service = await import("./flyto2/native-service.js");
      const tunnel = await import("./flyto2/native-tunnel.js");
      const runtimeService = service.nativeRuntimeServiceStatus();
      const tunnelStatus = tunnel.nativeTunnelStatus();
      const serviceLastExit = "lastExitStatus" in runtimeService ? runtimeService.lastExitStatus : undefined;
      console.log(
        `Background service: ${describeServiceState(nativeServiceState(runtimeService), serviceLastExit)} (${runtimeService.label})`,
      );
      console.log(
        `Tunnel redundancy: ${tunnelStatus.redundant ? "ready" : tunnelStatus.configured ? "degraded" : "not configured"} (${tunnelStatus.running_connectors}/${tunnelStatus.connector_count})`,
      );
      if (process.platform === "darwin") {
        const legacy = await import("./flyto2/macos-service.js");
        const legacyService = legacy.legacyMacKitStatus();
        console.log(
          `Legacy Mac Kit: service=${legacyService.serviceLoaded ? "loaded" : "stopped"}, updater=${legacyService.updaterLoaded ? "loaded" : "stopped"}`,
        );
      }
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

  const value = rest.join(" ").trim();
  if (!key || !value) {
    throw new Error(
      "Usage: devspace config set <publicBaseUrl|tools.mode|tools.exposeRuntimeInternals> <value>",
    );
  }

  switch (key) {
    case "publicBaseUrl":
      setDevspaceConfigValue(
        ["server", "publicBaseUrl"],
        normalizeOptionalPublicBaseUrl(value),
      );
      break;
    case "tools.mode":
      if (value !== "codex" && value !== "claude") {
        throw new Error("tools.mode must be `codex` or `claude`.");
      }
      setDevspaceConfigValue(["tools", "mode"], value);
      break;
    case "tools.exposeRuntimeInternals":
      if (value !== "true" && value !== "false") {
        throw new Error("tools.exposeRuntimeInternals must be `true` or `false`.");
      }
      setDevspaceConfigValue(
        ["tools", "exposeRuntimeInternals"],
        value === "true",
      );
      break;
    default:
      throw new Error(
        "Supported config keys: publicBaseUrl, tools.mode, tools.exposeRuntimeInternals.",
      );
  }
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

async function runQuickTunnelCommand(args: string[]): Promise<void> {
  const quick = await import("./flyto2/quick-tunnel-service.js");
  const [action = "status", ...extra] = args;
  if (extra.length > 0) throw new Error("Usage: flyto2-runtime service quick-tunnel [start|stop|status]");
  switch (action) {
    case "start": {
      const status = await startQuickTunnelForConfig(quick);
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    case "stop":
      console.log(JSON.stringify(await quick.stopQuickTunnel(), null, 2));
      return;
    case "status":
      console.log(JSON.stringify(await quick.quickTunnelStatus(), null, 2));
      return;
    default:
      throw new Error("Usage: flyto2-runtime service quick-tunnel [start|stop|status]");
  }
}

// Starts the quick tunnel, saves its URL as the public URL, and returns it.
async function startQuickTunnelForConfig(
  quick: typeof import("./flyto2/quick-tunnel-service.js"),
): Promise<Awaited<ReturnType<typeof quick.startQuickTunnel>>> {
  const binaryPath = quick.findCloudflared();
  if (!binaryPath) {
    throw new Error(
      process.platform === "win32"
        ? "cloudflared is not installed. Install it with: winget install --id Cloudflare.cloudflared"
        : "cloudflared is not installed. Install it with: brew install cloudflared",
    );
  }
  const files = loadDevspaceFiles();
  const status = await quick.startQuickTunnel({ binaryPath, originPort: files.config.server.port });
  setDevspaceConfigValues([{ path: ["server", "publicBaseUrl"], value: status.public_base_url }]);
  return status;
}

// `service self-update` is safe to run from the Runtime's own shell (a remote
// host's exec_command): it only schedules an OS-owned job and returns.
async function runSelfUpdateCommand(args: string[]): Promise<void> {
  const selfUpdate = await import("./flyto2/self-update.js");
  const { flyto2NativeRuntimeHome } = await import("./flyto2/native-paths.js");
  const { flyto2BuildInfo } = await import("./flyto2/build-info.js");
  const paths = selfUpdate.selfUpdatePaths(flyto2NativeRuntimeHome());
  const [action, requestId, ...extra] = args;
  const usage = "Usage: flyto2-runtime service self-update [status]";

  if (action === undefined) {
    const service = await import("./flyto2/native-service.js");
    if (!service.nativeRuntimeServiceStatus().installed) {
      throw new Error(
        "Remote self-update switches the background service, which is not installed. Run `flyto2-runtime service install` first.",
      );
    }
    const { nativeSelfUpdateScheduler } = await import("./flyto2/self-update-scheduler.js");
    const status = selfUpdate.scheduleSelfUpdate(paths, await nativeSelfUpdateScheduler(paths));
    console.log(JSON.stringify({
      ...status,
      current_sha: flyto2BuildInfo().git_sha,
      next: "The update runs in the background: fetch main, require green CI, build, restart behind a health check, roll back on failure. "
        + "The connection drops for a few seconds during the restart. Check progress with `flyto2-runtime service self-update status`.",
    }, null, 2));
    return;
  }
  if (action === "status" && requestId === undefined) {
    console.log(JSON.stringify({
      current_sha: flyto2BuildInfo().git_sha,
      update: selfUpdate.readSelfUpdateStatus(paths) ?? null,
    }, null, 2));
    return;
  }
  if (action === "run" && requestId && extra.length === 0) {
    const { spawnSync } = await import("node:child_process");
    const service = await import("./flyto2/native-service.js");
    const status = await selfUpdate.runSelfUpdate(requestId, paths, {
      run: (command, commandArgs, options) => {
        const result = spawnSync(command, commandArgs, {
          cwd: options?.cwd,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          // Only npm-style .cmd shims need a shell; git paths may contain spaces.
          shell: process.platform === "win32" && command.endsWith(".cmd"),
          windowsHide: true,
        });
        return {
          status: result.status,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? (result.error ? String(result.error) : ""),
        };
      },
      fetchCheckRuns: (sha) => selfUpdate.fetchCheckRuns(sha),
      currentGitSha: () => flyto2BuildInfo().git_sha,
      activate: (packageRoot) => {
        service.installNativeRuntimeService({
          packageRoot,
          configDirectory: loadDevspaceFiles().dir,
          start: true,
        });
      },
      pnpmCommand: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    });
    console.log(JSON.stringify(status, null, 2));
    if (status.phase === "failed" || status.phase === "rolled_back") process.exitCode = 1;
    return;
  }
  throw new Error(usage);
}

async function runServiceCommand(args: string[]): Promise<void> {
  const [subcommand = "status", ...rest] = args;
  const usage =
    "Usage: flyto2-runtime service <stage|install|start|stop|restart|status|update|self-update [status]|quick-tunnel [start|stop|status]|rollback|uninstall|legacy-status|disable-legacy-updater|restore-legacy|tunnel-import|tunnel-migrate|tunnel-start|tunnel-stop|tunnel-status>";
  if (subcommand === "self-update") {
    await runSelfUpdateCommand(rest);
    return;
  }
  if (subcommand === "quick-tunnel") {
    await runQuickTunnelCommand(rest);
    return;
  }
  if (subcommand !== "tunnel-import" && rest.length > 0) throw new Error(usage);

  const service = await import("./flyto2/native-service.js");
  const tunnel = await import("./flyto2/native-tunnel.js");
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
      let profile = tunnel.loadNativeTunnelProfile();
      if (!profile && process.platform === "darwin") {
        try {
          profile = tunnel.migrateLegacyCloudflareTunnel(configDirectory);
        } catch {
          // Tunnel configuration is optional. Stage the Runtime even when no
          // legacy Cloudflare profile exists.
        }
      }
      const tunnelStatus = profile
        ? tunnel.installNativeTunnelService(false)
        : tunnel.nativeTunnelStatus();
      const runtime = service.installNativeRuntimeService({
        configDirectory,
        start: false,
      });
      const legacy = process.platform === "darwin"
        ? (await import("./flyto2/macos-service.js")).legacyMacKitStatus()
        : undefined;
      console.log(JSON.stringify({
        runtime,
        tunnel: tunnelStatus,
        ...(profile ? { tunnel_profile: profile } : {}),
        ...(legacy ? { legacy } : {}),
      }, null, 2));
      return;
    }
    case "install": {
      const runtime = service.installNativeRuntimeService();
      const nativeTunnel = startTunnelIfConfigured();
      console.log(JSON.stringify({ runtime, tunnel: nativeTunnel }, null, 2));
      return;
    }
    case "start": {
      const runtime = service.startNativeRuntimeService();
      const nativeTunnel = startTunnelIfConfigured();
      console.log(JSON.stringify({ runtime, tunnel: nativeTunnel }, null, 2));
      return;
    }
    case "stop": {
      const nativeTunnel = stopTunnelIfConfigured();
      const runtime = service.stopNativeRuntimeService();
      console.log(JSON.stringify({ runtime, tunnel: nativeTunnel }, null, 2));
      return;
    }
    case "restart": {
      const runtime = service.restartNativeRuntimeService();
      const nativeTunnel = startTunnelIfConfigured();
      console.log(JSON.stringify({ runtime, tunnel: nativeTunnel }, null, 2));
      return;
    }
    case "status": {
      const legacy = process.platform === "darwin"
        ? (await import("./flyto2/macos-service.js")).legacyMacKitStatus()
        : undefined;
      console.log(JSON.stringify({
        runtime: service.nativeRuntimeServiceStatus(),
        tunnel: tunnel.nativeTunnelStatus(),
        ...(legacy ? { legacy } : {}),
      }, null, 2));
      return;
    }
    case "update": {
      const updater = await import("./flyto2/github-release-updater.js");
      const release = await updater.installLatestFlyto2Release();
      const runtime = service.installNativeRuntimeService({
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
      console.log(JSON.stringify(service.rollbackNativeRuntimeService(), null, 2));
      return;
    case "uninstall": {
      const nativeTunnel = stopTunnelIfConfigured();
      const runtime = service.uninstallNativeRuntimeService();
      console.log(JSON.stringify({ runtime, tunnel: nativeTunnel }, null, 2));
      return;
    }
    case "legacy-status": {
      if (process.platform !== "darwin") {
        throw new Error("Legacy Mac Kit commands are available on macOS only.");
      }
      const legacy = await import("./flyto2/macos-service.js");
      console.log(JSON.stringify(legacy.legacyMacKitStatus(), null, 2));
      return;
    }
    case "disable-legacy-updater": {
      if (process.platform !== "darwin") {
        throw new Error("Legacy Mac Kit commands are available on macOS only.");
      }
      const legacy = await import("./flyto2/macos-service.js");
      console.log(JSON.stringify(legacy.stopLegacyMacKitUpdater(), null, 2));
      return;
    }
    case "restore-legacy": {
      if (process.platform !== "darwin") {
        throw new Error("Legacy Mac Kit commands are available on macOS only.");
      }
      const legacy = await import("./flyto2/macos-service.js");
      console.log(JSON.stringify(legacy.restoreLegacyMacKit(), null, 2));
      return;
    }
    case "tunnel-import": {
      const configPath = rest[0];
      if (!configPath) {
        throw new Error(
          "Usage: flyto2-runtime service tunnel-import <config-path> [--cloudflared <path>] [--hostname <host>]",
        );
      }
      let binaryPath: string | undefined;
      let hostname: string | undefined;
      for (let index = 1; index < rest.length; index += 1) {
        const flag = rest[index];
        const value = rest[index + 1];
        if (flag === "--cloudflared" && value) {
          binaryPath = value;
          index += 1;
          continue;
        }
        if (flag === "--hostname" && value) {
          hostname = value;
          index += 1;
          continue;
        }
        throw new Error(
          "Usage: flyto2-runtime service tunnel-import <config-path> [--cloudflared <path>] [--hostname <host>]",
        );
      }
      const profile = tunnel.importCloudflareTunnel({
        configPath,
        ...(binaryPath ? { binaryPath } : {}),
        ...(hostname ? { hostname } : {}),
      });
      const status = tunnel.installNativeTunnelService(false);
      console.log(JSON.stringify({ profile, status }, null, 2));
      return;
    }
    case "tunnel-migrate": {
      if (process.platform !== "darwin") {
        throw new Error("Legacy tunnel migration is available on macOS only.");
      }
      const profile = tunnel.migrateLegacyCloudflareTunnel(
        loadDevspaceFiles().dir,
      );
      const status = tunnel.installNativeTunnelService(false);
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

  const launcher = process.platform === "win32"
    ? await import("./flyto2/windows-launcher.js")
    : await import("./flyto2/macos-launcher.js");

  switch (subcommand) {
    case "install": {
      const installed = process.platform === "win32"
        ? (launcher as typeof import("./flyto2/windows-launcher.js")).installWindowsDesktopLaunchers()
        : (launcher as typeof import("./flyto2/macos-launcher.js")).installMacDesktopLaunchers();
      console.log(JSON.stringify({ ok: true, ...installed }, null, 2));
      return;
    }
    case "status": {
      const status = process.platform === "win32"
        ? (launcher as typeof import("./flyto2/windows-launcher.js")).windowsDesktopLauncherStatus()
        : (launcher as typeof import("./flyto2/macos-launcher.js")).macDesktopLauncherStatus();
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    case "remove": {
      const directory = process.platform === "win32"
        ? (launcher as typeof import("./flyto2/windows-launcher.js")).removeWindowsDesktopLaunchers()
        : (launcher as typeof import("./flyto2/macos-launcher.js")).removeMacDesktopLaunchers();
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
        { value: "plugin", label: "Export ChatGPT plugin", hint: "Create an upload-ready ZIP from this Runtime config" },
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
        if (process.platform === "darwin" || process.platform === "win32") {
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
        await runInit({ force: true, exitLabel: "Back to main menu" });
        break;
      case "plugin":
        await runPluginCommand(["build"]);
        break;
      case "launcher": {
        if (process.platform === "win32") {
          const { installWindowsDesktopLaunchers } = await import("./flyto2/windows-launcher.js");
          const installed = installWindowsDesktopLaunchers(process.cwd());
          prompts.log.success("Desktop launchers installed at " + installed.directory);
        } else {
          const { installMacDesktopLaunchers } = await import("./flyto2/macos-launcher.js");
          const installed = installMacDesktopLaunchers(process.cwd());
          prompts.log.success("Desktop launchers installed at " + installed.directory);
        }
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

async function runPluginCommand(args: string[]): Promise<void> {
  const [candidateSubcommand, ...candidateRest] = args;
  const subcommand = candidateSubcommand?.startsWith("--")
    ? "build"
    : candidateSubcommand ?? "build";
  const rest = candidateSubcommand?.startsWith("--") ? args : candidateRest;

  if (subcommand === "help" || rest.includes("--help") || rest.includes("-h")) {
    printPluginHelp();
    return;
  }
  if (subcommand !== "build") {
    throw new Error("Usage: flyto2-runtime plugin build [options]");
  }

  const options = parsePluginBuildArgs(rest);
  const files = loadDevspaceFiles();
  const configuredBaseUrl = files.config.server.publicBaseUrl;
  const mcpUrl = options.mcpUrl
    ?? (options.baseUrl
      ? mcpUrlFromPublicBaseUrl(options.baseUrl)
      : configuredBaseUrl
        ? mcpUrlFromPublicBaseUrl(configuredBaseUrl)
        : undefined);
  if (!mcpUrl) {
    throw new Error(
      [
        "No public MCP URL is configured.",
        "Set server.publicBaseUrl during setup, run:",
        "  flyto2-runtime config set publicBaseUrl https://your-runtime-host.example.com",
        "or pass --url https://your-runtime-host.example.com/mcp.",
      ].join("\n"),
    );
  }

  const packageJson = require("../package.json") as { version?: unknown };
  const version = options.version
    ?? (typeof packageJson.version === "string" ? packageJson.version : "1.0.0");
  const result = await writePortablePluginPackage({
    mcpUrl,
    version,
    name: options.name,
    serverName: options.serverName,
    displayName: options.displayName,
    description: options.description,
    outputPath: options.outputPath,
  });

  if (options.json) {
    printJson({ ok: true, ...result });
    return;
  }

  console.log(`Created ChatGPT plugin: ${result.outputPath}`);
  console.log(`MCP URL: ${result.mcpUrl}`);
  console.log("Upload the ZIP in ChatGPT Plugins. OAuth credentials are not stored in the package.");
}

interface PluginBuildCliOptions {
  mcpUrl?: string;
  baseUrl?: string;
  name?: string;
  serverName?: string;
  displayName?: string;
  description?: string;
  version?: string;
  outputPath?: string;
  json: boolean;
}

function parsePluginBuildArgs(args: string[]): PluginBuildCliOptions {
  const options: PluginBuildCliOptions = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--json") {
      options.json = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.\n\n${pluginHelpText()}`);
    }
    index += 1;

    switch (flag) {
      case "--url":
      case "--mcp-url":
        options.mcpUrl = value;
        break;
      case "--base-url":
        options.baseUrl = value;
        break;
      case "--name":
        options.name = value;
        break;
      case "--server-name":
        options.serverName = value;
        break;
      case "--display-name":
        options.displayName = value;
        break;
      case "--description":
        options.description = value;
        break;
      case "--version":
        options.version = value;
        break;
      case "--output":
        options.outputPath = value;
        break;
      default:
        throw new Error(`Unknown plugin option: ${flag}.\n\n${pluginHelpText()}`);
    }
  }

  if (options.mcpUrl && options.baseUrl) {
    throw new Error("Use either --url or --base-url, not both.");
  }
  return options;
}

function pluginHelpText(): string {
  return [
    "Flyto2 Runtime plugin packaging",
    "",
    "Usage:",
    "  flyto2-runtime plugin build [options]",
    "",
    "By default the package uses server.publicBaseUrl from Runtime config and writes",
    "a personalized upload-ready ZIP to ~/Downloads when that folder exists.",
    "",
    "Options:",
    "  --url <https-url>          Full MCP endpoint; for example https://host.example/mcp",
    "  --base-url <https-url>     Public Runtime base URL; /mcp is added automatically",
    `  --name <kebab-name>       Plugin id (default: ${DEFAULT_PLUGIN_NAME})`,
    "  --server-name <name>       MCP server id (letters, digits, dots, underscores, hyphens)",
    `  --display-name <name>      Human name (default: ${DEFAULT_PLUGIN_DISPLAY_NAME})`,
    `  --description <text>       Plugin purpose (default: ${DEFAULT_PLUGIN_DESCRIPTION})`,
    "  --version <semver>         Plugin version (default: Runtime package version)",
    "  --output <file.zip>        Destination ZIP path",
    "  --json                     Print machine-readable result",
    "",
    "The ZIP contains plugin.json, mcp.json, and a Runtime skill. It never contains",
    "the Owner password, OAuth tokens, tunnel credentials, or auth.json.",
  ].join("\n");
}

function printPluginHelp(): void {
  console.log(pluginHelpText());
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
      "  flyto2-runtime config set tools.mode <codex|claude>",
      "  flyto2-runtime config set tools.exposeRuntimeInternals <true|false>",
      "  devspace worktrees prune Prune managed worktrees unused for 3 days",
      "  devspace show-changes <review-ref> [--json]",
      "  flyto2-runtime flyto2 manifest",
      "  flyto2-runtime flyto2 status",
      "  flyto2-runtime flyto2 pair <pairing-code> [--cloud-url https://api.flyto2.com]",
      "  flyto2-runtime flyto2 next   Wait for one Cloud assignment without executing it",
      "  flyto2-runtime menu          Open the interactive Flyto2 Runtime launcher",
      "  flyto2-runtime launcher install|status|remove",
      "  flyto2-runtime service install|start|stop|restart|status|update|rollback|uninstall",
      "  flyto2-runtime plugin build [options]  Create an upload-ready portable ChatGPT plugin ZIP",
      "  devspace agents targets [--json]  List usable subagent providers and profiles",
      "  devspace agents ls       List subagent sessions",
      "  devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] <prompt>",
      "  devspace agents continue <id> [--model <model>] [--effort <level>] <prompt>",
      "  devspace agents show <id> [--json]",
      "  devspace agents wait <id>... [--timeout <seconds>] [--json]",
      "  devspace agents daemon <status|stop|logs>",
      "  devspace -v, --version   Print the installed version",
      "",
      "For Codex-first operation:",
      "  flyto2-runtime config set tools.mode codex",
      "  flyto2-runtime service restart",
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
  const validationError = validatePublicBaseUrl(trimmed);
  if (validationError) return validationError;
  return new URL(trimmed).protocol === "https:"
    ? undefined
    : "ChatGPT requires a public HTTPS URL.";
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
