import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { devspaceConfigDir } from "../user-config.js";
import { loadConfig } from "../config.js";
import { flyto2RuntimePackageRoot } from "./macos-launcher.js";

export const FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL = "local.flyto2.runtime";
export const LEGACY_DEVSPACE_LAUNCH_AGENT_LABEL = "local.devspace.mac-kit";
export const LEGACY_DEVSPACE_UPDATER_LABEL = "local.devspace.mac-kit.updater";

export interface MacRuntimeServicePaths {
  plistPath: string;
  previousPlistPath: string;
  activePlistPath: string;
  logsDirectory: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface MacRuntimeServiceStatus {
  supported: boolean;
  label: string;
  installed: boolean;
  loaded: boolean;
  state?: string;
  pid?: number;
  lastExitStatus?: number;
  plistPath: string;
  packageRoot: string;
  configDirectory: string;
}

export interface InstallMacRuntimeServiceOptions {
  packageRoot?: string;
  configDirectory?: string;
  nodePath?: string;
  homeDirectory?: string;
  pathEnvironment?: string;
  start?: boolean;
}

export interface LegacyMacKitStatus {
  serviceLoaded: boolean;
  updaterLoaded: boolean;
  servicePlistExists: boolean;
  updaterPlistExists: boolean;
}

export interface LaunchAgentRestartOperations {
  bootout: () => void;
  isLoaded: () => boolean;
  activate: () => void;
  isHealthy: () => boolean;
  rollback: () => void;
  sleep: (milliseconds: number) => void;
}

export interface LaunchAgentRestartPolicy {
  name?: string;
  healthDescription?: string;
  unloadTimeoutMs?: number;
  activationAttempts?: number;
  activationRetryDelayMs?: number;
  healthTimeoutMs?: number;
  healthPollIntervalMs?: number;
}

export function macRuntimeServicePaths(
  homeDirectory = homedir(),
): MacRuntimeServicePaths {
  const launchAgents = join(homeDirectory, "Library", "LaunchAgents");
  const logsDirectory = join(homeDirectory, "Library", "Logs", "Flyto2 Runtime");
  const plistPath = join(
    launchAgents,
    `${FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL}.plist`,
  );
  return {
    plistPath,
    previousPlistPath: `${plistPath}.previous`,
    activePlistPath: `${plistPath}.active`,
    logsDirectory,
    stdoutPath: join(logsDirectory, "runtime.log"),
    stderrPath: join(logsDirectory, "runtime-error.log"),
  };
}

export function renderMacRuntimeLaunchAgent(options: {
  packageRoot: string;
  configDirectory: string;
  nodePath?: string;
  pathEnvironment?: string;
  homeDirectory?: string;
}): string {
  const paths = macRuntimeServicePaths(options.homeDirectory);
  const nodePath = options.nodePath ?? process.execPath;
  const cliPath = join(options.packageRoot, "dist", "cli.js");
  const pathEnvironment = options.pathEnvironment
    ?? [dirname(nodePath), process.env.PATH].filter(Boolean).join(":");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(nodePath)}</string>`,
    `    <string>${xmlEscape(cliPath)}</string>`,
    "    <string>serve</string>",
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(options.packageRoot)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>FLYTO2_RUNTIME_CONFIG_DIR</key>",
    `    <string>${xmlEscape(options.configDirectory)}</string>`,
    "    <key>FLYTO2_RUNTIME_MANAGED_SERVICE</key>",
    "    <string>1</string>",
    "    <key>DEVSPACE_CONFIG_DIR</key>",
    `    <string>${xmlEscape(options.configDirectory)}</string>`,
    "    <key>PATH</key>",
    `    <string>${xmlEscape(pathEnvironment)}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>1</integer>",
    "  <key>ProcessType</key>",
    "  <string>Interactive</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(paths.stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(paths.stderrPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function installMacRuntimeService(
  options: InstallMacRuntimeServiceOptions = {},
): MacRuntimeServiceStatus {
  assertMacOs();
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const nodePath = options.nodePath ?? process.execPath;
  const homeDirectory = options.homeDirectory ?? homedir();
  const paths = macRuntimeServicePaths(homeDirectory);
  const cliPath = join(packageRoot, "dist", "cli.js");

  if (!existsSync(cliPath)) {
    throw new Error(
      `Flyto2 Runtime build is missing at ${cliPath}. Run the build before installing the service.`,
    );
  }

  mkdirSync(dirname(paths.plistPath), { recursive: true, mode: 0o700 });
  mkdirSync(paths.logsDirectory, { recursive: true, mode: 0o700 });

  const next = renderMacRuntimeLaunchAgent({
    packageRoot,
    configDirectory,
    nodePath,
    pathEnvironment: options.pathEnvironment,
    homeDirectory,
  });
  let requiresReload = false;
  if (existsSync(paths.plistPath)) {
    const current = readFileSync(paths.plistPath, "utf8");
    if (current !== next) {
      copyFileSync(paths.plistPath, paths.previousPlistPath);
      requiresReload = true;
    }
  }

  const temporary = `${paths.plistPath}.tmp-${process.pid}`;
  writeFileSync(temporary, next, { mode: 0o600 });
  renameSync(temporary, paths.plistPath);

  if (options.start !== false) {
    if (requiresReload) {
      return reloadMacRuntimeService({
        packageRoot,
        configDirectory,
        nodePath,
        homeDirectory,
        pathEnvironment: options.pathEnvironment,
      });
    }
    return restartMacRuntimeService({
      packageRoot,
      configDirectory,
      nodePath,
      homeDirectory,
      pathEnvironment: options.pathEnvironment,
    });
  }

  return macRuntimeServiceStatus({
    packageRoot,
    configDirectory,
    homeDirectory,
  });
}

export function startMacRuntimeService(
  options: Omit<InstallMacRuntimeServiceOptions, "start"> = {},
): MacRuntimeServiceStatus {
  assertMacOs();
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const homeDirectory = options.homeDirectory ?? homedir();
  const paths = macRuntimeServicePaths(homeDirectory);
  if (!existsSync(paths.plistPath)) {
    return installMacRuntimeService({ ...options, start: true });
  }

  return restartMacRuntimeService({
    ...options,
    packageRoot,
    configDirectory,
    homeDirectory,
  });
}

export function stopMacRuntimeService(
  options: Pick<InstallMacRuntimeServiceOptions, "packageRoot" | "configDirectory" | "homeDirectory"> = {},
): MacRuntimeServiceStatus {
  assertMacOs();
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const homeDirectory = options.homeDirectory ?? homedir();
  bootoutLabel(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL);
  return macRuntimeServiceStatus({ packageRoot, configDirectory, homeDirectory });
}

export function restartMacRuntimeService(
  options: Omit<InstallMacRuntimeServiceOptions, "start"> = {},
): MacRuntimeServiceStatus {
  assertMacOs();
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const homeDirectory = options.homeDirectory ?? homedir();
  const paths = macRuntimeServicePaths(homeDirectory);
  if (!existsSync(paths.plistPath)) {
    return installMacRuntimeService({ ...options, start: true });
  }
  const config = loadConfig({
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDirectory,
    FLYTO2_RUNTIME_CONFIG_DIR: configDirectory,
  });
  const healthUrl = localRuntimeHealthUrl(config.host, config.port);
  const activePlistMatches = !existsSync(paths.activePlistPath)
    || readFileSync(paths.activePlistPath, "utf8") === readFileSync(paths.plistPath, "utf8");
  if (isLaunchAgentLoaded(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL) && activePlistMatches) {
    enableAndKickstartLaunchAgent();
    if (!waitForRuntimeHealth(healthUrl, 10_000, 100)) {
      throw new Error("Flyto2 Runtime did not pass /healthz after restart.");
    }
    copyFileSync(paths.plistPath, paths.activePlistPath);
    return macRuntimeServiceStatus({ packageRoot, configDirectory, homeDirectory });
  }

  return reloadMacRuntimeService(options);
}

function reloadMacRuntimeService(
  options: Omit<InstallMacRuntimeServiceOptions, "start"> = {},
): MacRuntimeServiceStatus {
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const homeDirectory = options.homeDirectory ?? homedir();
  const paths = macRuntimeServicePaths(homeDirectory);
  const config = loadConfig({
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDirectory,
    FLYTO2_RUNTIME_CONFIG_DIR: configDirectory,
  });
  const healthUrl = localRuntimeHealthUrl(config.host, config.port);
  const hasPreviousPlist = existsSync(paths.previousPlistPath);

  restartLaunchAgentWithRecovery({
    bootout: () => bootoutLabel(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL),
    isLoaded: () => isLaunchAgentLoaded(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL),
    activate: () => activateLaunchAgent(paths.plistPath),
    isHealthy: () => runtimeHealthCheck(healthUrl),
    rollback: () => {
      if (hasPreviousPlist) {
        copyFileSync(paths.previousPlistPath, paths.plistPath);
      }
    },
    sleep: sleepSync,
  });
  copyFileSync(paths.plistPath, paths.activePlistPath);
  return macRuntimeServiceStatus({ packageRoot, configDirectory, homeDirectory });
}

export function restartLaunchAgentWithRecovery(
  operations: LaunchAgentRestartOperations,
  policy: LaunchAgentRestartPolicy = {},
): void {
  const name = policy.name ?? "Flyto2 Runtime";
  const healthDescription = policy.healthDescription ?? "/healthz";
  const unloadTimeoutMs = policy.unloadTimeoutMs ?? 2_000;
  const activationAttempts = policy.activationAttempts ?? 21;
  const activationRetryDelayMs = policy.activationRetryDelayMs ?? 250;
  const healthTimeoutMs = policy.healthTimeoutMs ?? 10_000;
  const healthPollIntervalMs = policy.healthPollIntervalMs ?? 100;

  const waitUntil = (
    predicate: () => boolean,
    timeoutMs: number,
    intervalMs: number,
  ): boolean => {
    const deadline = Date.now() + timeoutMs;
    do {
      if (predicate()) return true;
      operations.sleep(intervalMs);
    } while (Date.now() < deadline);
    return predicate();
  };

  const unload = (): void => {
    operations.bootout();
    if (!waitUntil(() => !operations.isLoaded(), unloadTimeoutMs, 50)) {
      throw new Error(`${name} LaunchAgent did not finish unloading.`);
    }
  };

  const activate = (): void => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= activationAttempts; attempt += 1) {
      try {
        operations.activate();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < activationAttempts) operations.sleep(activationRetryDelayMs);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`${name} LaunchAgent activation failed.`);
  };

  const waitForHealth = (): void => {
    if (!waitUntil(operations.isHealthy, healthTimeoutMs, healthPollIntervalMs)) {
      throw new Error(`${name} did not pass ${healthDescription} after activation.`);
    }
  };

  try {
    unload();
    activate();
    waitForHealth();
  } catch (restartError) {
    try {
      unload();
      operations.rollback();
      activate();
      waitForHealth();
    } catch (rollbackError) {
      throw new AggregateError(
        [restartError, rollbackError],
        `${name} restart and automatic rollback both failed.`,
      );
    }
    throw new Error(
      `${name} restart failed and the previous service was restored: ${errorMessage(restartError)}`,
      { cause: restartError },
    );
  }
}

export function uninstallMacRuntimeService(
  options: Pick<InstallMacRuntimeServiceOptions, "packageRoot" | "configDirectory" | "homeDirectory"> = {},
): MacRuntimeServiceStatus {
  assertMacOs();
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const homeDirectory = options.homeDirectory ?? homedir();
  const paths = macRuntimeServicePaths(homeDirectory);
  bootoutLabel(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL);
  rmSync(paths.plistPath, { force: true });
  return macRuntimeServiceStatus({ packageRoot, configDirectory, homeDirectory });
}

export function rollbackMacRuntimeService(
  options: Pick<InstallMacRuntimeServiceOptions, "packageRoot" | "configDirectory" | "homeDirectory"> = {},
): MacRuntimeServiceStatus {
  assertMacOs();
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const homeDirectory = options.homeDirectory ?? homedir();
  const paths = macRuntimeServicePaths(homeDirectory);
  if (!existsSync(paths.previousPlistPath)) {
    throw new Error("No previous Flyto2 Runtime LaunchAgent is available for rollback.");
  }

  bootoutLabel(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL);
  copyFileSync(paths.previousPlistPath, paths.plistPath);
  bootstrapLaunchAgent(paths.plistPath);
  return macRuntimeServiceStatus({ packageRoot, configDirectory, homeDirectory });
}

export function macRuntimeServiceStatus(options: {
  packageRoot?: string;
  configDirectory?: string;
  homeDirectory?: string;
} = {}): MacRuntimeServiceStatus {
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const homeDirectory = options.homeDirectory ?? homedir();
  const paths = macRuntimeServicePaths(homeDirectory);

  if (platform() !== "darwin") {
    return {
      supported: false,
      label: FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL,
      installed: false,
      loaded: false,
      plistPath: paths.plistPath,
      packageRoot,
      configDirectory,
    };
  }

  const detail = launchctlPrint(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL);
  return {
    supported: true,
    label: FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL,
    installed: existsSync(paths.plistPath),
    loaded: detail !== undefined,
    ...(detail?.state ? { state: detail.state } : {}),
    ...(detail?.pid !== undefined ? { pid: detail.pid } : {}),
    ...(detail?.lastExitStatus !== undefined
      ? { lastExitStatus: detail.lastExitStatus }
      : {}),
    plistPath: paths.plistPath,
    packageRoot,
    configDirectory,
  };
}

export function legacyMacKitStatus(homeDirectory = homedir()): LegacyMacKitStatus {
  const launchAgents = join(homeDirectory, "Library", "LaunchAgents");
  return {
    serviceLoaded: platform() === "darwin"
      && isLaunchAgentLoaded(LEGACY_DEVSPACE_LAUNCH_AGENT_LABEL),
    updaterLoaded: platform() === "darwin"
      && isLaunchAgentLoaded(LEGACY_DEVSPACE_UPDATER_LABEL),
    servicePlistExists: existsSync(
      join(launchAgents, `${LEGACY_DEVSPACE_LAUNCH_AGENT_LABEL}.plist`),
    ),
    updaterPlistExists: existsSync(
      join(launchAgents, `${LEGACY_DEVSPACE_UPDATER_LABEL}.plist`),
    ),
  };
}

export function stopLegacyMacKit(): LegacyMacKitStatus {
  assertMacOs();
  bootoutLabel(LEGACY_DEVSPACE_UPDATER_LABEL);
  bootoutLabel(LEGACY_DEVSPACE_LAUNCH_AGENT_LABEL);
  return legacyMacKitStatus();
}

export function stopLegacyMacKitUpdater(): LegacyMacKitStatus {
  assertMacOs();
  bootoutLabel(LEGACY_DEVSPACE_UPDATER_LABEL);
  return legacyMacKitStatus();
}

export function restoreLegacyMacKit(homeDirectory = homedir()): LegacyMacKitStatus {
  assertMacOs();
  const launchAgents = join(homeDirectory, "Library", "LaunchAgents");
  const servicePlist = join(
    launchAgents,
    `${LEGACY_DEVSPACE_LAUNCH_AGENT_LABEL}.plist`,
  );
  const updaterPlist = join(
    launchAgents,
    `${LEGACY_DEVSPACE_UPDATER_LABEL}.plist`,
  );
  if (existsSync(servicePlist) && !isLaunchAgentLoaded(LEGACY_DEVSPACE_LAUNCH_AGENT_LABEL)) {
    bootstrapLaunchAgent(servicePlist);
  }
  if (existsSync(updaterPlist) && !isLaunchAgentLoaded(LEGACY_DEVSPACE_UPDATER_LABEL)) {
    bootstrapLaunchAgent(updaterPlist);
  }
  return legacyMacKitStatus(homeDirectory);
}

function bootstrapLaunchAgent(plistPath: string): void {
  runLaunchctl(["bootstrap", launchAgentDomain(), plistPath]);
  enableAndKickstartLaunchAgent();
}

function activateLaunchAgent(plistPath: string): void {
  if (!isLaunchAgentLoaded(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL)) {
    bootstrapLaunchAgent(plistPath);
    return;
  }
  enableAndKickstartLaunchAgent();
}

function enableAndKickstartLaunchAgent(): void {
  runLaunchctl([
    "enable",
    launchAgentTarget(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL),
  ], true);
  runLaunchctl([
    "kickstart",
    "-k",
    launchAgentTarget(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL),
  ]);
}

function localRuntimeHealthUrl(host: string, port: number): string {
  const localHost = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
  const formattedHost = localHost.includes(":") ? `[${localHost}]` : localHost;
  return `http://${formattedHost}:${port}/healthz`;
}

function runtimeHealthCheck(url: string): boolean {
  const script = [
    "const url = process.argv[1];",
    "fetch(url, { signal: AbortSignal.timeout(800) })",
    "  .then(async (response) => {",
    "    if (!response.ok) process.exit(1);",
    "    const body = await response.json();",
    "    process.exit(body?.ok === true && body?.name === 'flyto2-runtime' ? 0 : 1);",
    "  })",
    "  .catch(() => process.exit(1));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script, url], {
    encoding: "utf8",
    timeout: 1_000,
  });
  return result.status === 0;
}

function waitForRuntimeHealth(
  url: string,
  timeoutMs: number,
  intervalMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  do {
    if (runtimeHealthCheck(url)) return true;
    sleepSync(intervalMs);
  } while (Date.now() < deadline);
  return runtimeHealthCheck(url);
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bootoutLabel(label: string): void {
  if (!isLaunchAgentLoaded(label)) return;
  runLaunchctl(["bootout", launchAgentTarget(label)]);
}

function isLaunchAgentLoaded(label: string): boolean {
  return launchctlPrint(label) !== undefined;
}

function launchctlPrint(label: string): {
  state?: string;
  pid?: number;
  lastExitStatus?: number;
} | undefined {
  const result = spawnSync(
    "launchctl",
    ["print", launchAgentTarget(label)],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  const output = result.stdout ?? "";
  const state = /^\s*state = (.+)$/m.exec(output)?.[1]?.trim();
  const pidText = /^\s*pid = (\d+)$/m.exec(output)?.[1];
  const exitText = /^\s*last exit code = (-?\d+)$/m.exec(output)?.[1];
  return {
    ...(state ? { state } : {}),
    ...(pidText ? { pid: Number(pidText) } : {}),
    ...(exitText ? { lastExitStatus: Number(exitText) } : {}),
  };
}

function runLaunchctl(args: string[], tolerateFailure = false): void {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (result.status === 0 || tolerateFailure) return;
  throw new Error(
    `launchctl ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
  );
}

function launchAgentDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Unable to determine the current user id.");
  return `gui/${uid}`;
}

function launchAgentTarget(label: string): string {
  return `${launchAgentDomain()}/${label}`;
}

function assertMacOs(): void {
  if (platform() !== "darwin") {
    throw new Error("Flyto2 Runtime LaunchAgent service management is available on macOS only.");
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
