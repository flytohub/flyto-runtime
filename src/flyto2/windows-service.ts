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
import { win32 as winPath } from "node:path";
import { loadConfig } from "../config.js";
import { devspaceConfigDir } from "../user-config.js";
import { flyto2RuntimePackageRoot } from "./macos-launcher.js";
import {
  deleteWindowsScheduledTask,
  endWindowsScheduledTask,
  queryWindowsScheduledTaskXml,
  registerWindowsScheduledTask,
  renderWindowsScheduledTaskXml,
  runWindowsScheduledTask,
  windowsScheduledTaskExists,
  windowsTaskPrincipal,
} from "./windows-task.js";

export const FLYTO2_RUNTIME_WINDOWS_TASK = "Flyto2 Runtime";

export interface WindowsRuntimeServicePaths {
  serviceRoot: string;
  scriptPath: string;
  previousScriptPath: string;
  taskXmlPath: string;
  previousTaskXmlPath: string;
  activeTaskXmlPath: string;
}

export interface WindowsRuntimeServiceStatus {
  supported: boolean;
  label: string;
  installed: boolean;
  loaded: boolean;
  state?: string;
  taskName: string;
  taskXmlPath: string;
  packageRoot: string;
  configDirectory: string;
}

export interface InstallWindowsRuntimeServiceOptions {
  packageRoot?: string;
  configDirectory?: string;
  nodePath?: string;
  serviceRoot?: string;
  principal?: string;
  start?: boolean;
}

export function windowsRuntimeServiceRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const localAppData = env.LOCALAPPDATA?.trim();
  return localAppData
    ? winPath.join(localAppData, "Flyto2 Runtime", "service")
    : winPath.join(homeDirectory, "AppData", "Local", "Flyto2 Runtime", "service");
}

export function windowsRuntimeServicePaths(
  serviceRoot = windowsRuntimeServiceRoot(),
): WindowsRuntimeServicePaths {
  const taskXmlPath = winPath.join(serviceRoot, "runtime-task.xml");
  const scriptPath = winPath.join(serviceRoot, "run-runtime.ps1");
  return {
    serviceRoot,
    scriptPath,
    previousScriptPath: `${scriptPath}.previous`,
    taskXmlPath,
    previousTaskXmlPath: `${taskXmlPath}.previous`,
    activeTaskXmlPath: `${taskXmlPath}.active`,
  };
}

export function renderWindowsRuntimeScript(options: {
  packageRoot: string;
  configDirectory: string;
  nodePath: string;
}): string {
  const cliPath = winPath.join(options.packageRoot, "dist", "cli.js");
  const nodeDirectory = winPath.dirname(options.nodePath);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$env:FLYTO2_RUNTIME_CONFIG_DIR = '${powershellLiteral(options.configDirectory)}'`,
    "$env:FLYTO2_RUNTIME_MANAGED_SERVICE = '1'",
    `$env:DEVSPACE_CONFIG_DIR = '${powershellLiteral(options.configDirectory)}'`,
    `$env:PATH = '${powershellLiteral(nodeDirectory)};' + $env:PATH`,
    `Set-Location -LiteralPath '${powershellLiteral(options.packageRoot)}'`,
    "$restartDelaySeconds = 2",
    "while ($true) {",
    `  & '${powershellLiteral(options.nodePath)}' '${powershellLiteral(cliPath)}' 'serve'`,
    "  $exitCode = $LASTEXITCODE",
    "  if ($exitCode -eq 0) { exit 0 }",
    "  Start-Sleep -Seconds $restartDelaySeconds",
    "  $restartDelaySeconds = [Math]::Min(30, $restartDelaySeconds * 2)",
    "}",
    "",
  ].join("\r\n");
}

export function renderWindowsRuntimeTask(options: {
  scriptPath: string;
  packageRoot: string;
  principal?: string;
}): string {
  return renderWindowsScheduledTaskXml({
    command: "powershell.exe",
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      quoteWindowsArgument(options.scriptPath),
    ].join(" "),
    workingDirectory: options.packageRoot,
    principal: options.principal,
    logonTrigger: true,
    restartIntervalMinutes: 1,
    restartCount: 255,
  });
}

export function installWindowsRuntimeService(
  options: InstallWindowsRuntimeServiceOptions = {},
): WindowsRuntimeServiceStatus {
  assertWindows();
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const nodePath = options.nodePath ?? process.execPath;
  const paths = windowsRuntimeServicePaths(options.serviceRoot);
  const cliPath = winPath.join(packageRoot, "dist", "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(
      `Flyto2 Runtime build is missing at ${cliPath}. Run the build before installing the service.`,
    );
  }

  mkdirSync(paths.serviceRoot, { recursive: true });
  const previousRegisteredXml = queryWindowsScheduledTaskXml(FLYTO2_RUNTIME_WINDOWS_TASK);
  if (previousRegisteredXml) {
    writeFileSync(paths.previousTaskXmlPath, previousRegisteredXml, "utf8");
  } else if (existsSync(paths.taskXmlPath)) {
    copyFileSync(paths.taskXmlPath, paths.previousTaskXmlPath);
  }
  if (existsSync(paths.scriptPath)) {
    copyFileSync(paths.scriptPath, paths.previousScriptPath);
  }

  const script = renderWindowsRuntimeScript({
    packageRoot,
    configDirectory,
    nodePath,
  });
  const taskXml = renderWindowsRuntimeTask({
    scriptPath: paths.scriptPath,
    packageRoot,
    principal: options.principal ?? windowsTaskPrincipal(),
  });
  writeAtomic(paths.scriptPath, script);
  writeAtomic(paths.taskXmlPath, taskXml);
  registerWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK, paths.taskXmlPath);

  if (options.start !== false) {
    return restartWindowsRuntimeService({
      packageRoot,
      configDirectory,
      nodePath,
      serviceRoot: paths.serviceRoot,
      principal: options.principal,
    });
  }
  return windowsRuntimeServiceStatus({
    packageRoot,
    configDirectory,
    serviceRoot: paths.serviceRoot,
  });
}

export function startWindowsRuntimeService(
  options: Omit<InstallWindowsRuntimeServiceOptions, "start"> = {},
): WindowsRuntimeServiceStatus {
  assertWindows();
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const paths = windowsRuntimeServicePaths(options.serviceRoot);
  if (!windowsScheduledTaskExists(FLYTO2_RUNTIME_WINDOWS_TASK)) {
    return installWindowsRuntimeService({ ...options, start: true });
  }

  const healthUrl = runtimeHealthUrl(configDirectory);
  if (runtimeHealthCheck(healthUrl)) {
    return windowsRuntimeServiceStatus({
      packageRoot,
      configDirectory,
      serviceRoot: paths.serviceRoot,
    });
  }
  runWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK);
  if (!waitForRuntimeHealth(healthUrl, 12_000, 150)) {
    throw new Error("Flyto2 Runtime did not pass /healthz after Windows service start.");
  }
  if (existsSync(paths.taskXmlPath)) {
    copyFileSync(paths.taskXmlPath, paths.activeTaskXmlPath);
  }
  return windowsRuntimeServiceStatus({
    packageRoot,
    configDirectory,
    serviceRoot: paths.serviceRoot,
  });
}

export function restartWindowsRuntimeService(
  options: Omit<InstallWindowsRuntimeServiceOptions, "start"> = {},
): WindowsRuntimeServiceStatus {
  assertWindows();
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const paths = windowsRuntimeServicePaths(options.serviceRoot);
  if (!windowsScheduledTaskExists(FLYTO2_RUNTIME_WINDOWS_TASK)) {
    return installWindowsRuntimeService({ ...options, start: true });
  }
  const healthUrl = runtimeHealthUrl(configDirectory);

  try {
    endWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK);
    waitForRuntimeStop(healthUrl, 4_000, 100);
    runWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK);
    if (!waitForRuntimeHealth(healthUrl, 12_000, 150)) {
      throw new Error("Flyto2 Runtime did not pass /healthz after Windows service restart.");
    }
    if (existsSync(paths.taskXmlPath)) {
      copyFileSync(paths.taskXmlPath, paths.activeTaskXmlPath);
    }
  } catch (restartError) {
    const rollbackAvailable = existsSync(paths.previousTaskXmlPath)
      && existsSync(paths.previousScriptPath);
    if (!rollbackAvailable) throw restartError;

    try {
      endWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK);
      copyFileSync(paths.previousTaskXmlPath, paths.taskXmlPath);
      copyFileSync(paths.previousScriptPath, paths.scriptPath);
      registerWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK, paths.taskXmlPath);
      runWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK);
      if (!waitForRuntimeHealth(healthUrl, 12_000, 150)) {
        throw new Error("Previous Flyto2 Runtime task did not recover.");
      }
      copyFileSync(paths.taskXmlPath, paths.activeTaskXmlPath);
    } catch (rollbackError) {
      throw new AggregateError(
        [restartError, rollbackError],
        "Flyto2 Runtime Windows restart and automatic rollback both failed.",
      );
    }
    throw new Error(
      `Flyto2 Runtime Windows restart failed and the previous service was restored: ${errorMessage(restartError)}`,
      { cause: restartError },
    );
  }

  return windowsRuntimeServiceStatus({
    packageRoot,
    configDirectory,
    serviceRoot: paths.serviceRoot,
  });
}

export function stopWindowsRuntimeService(
  options: Pick<InstallWindowsRuntimeServiceOptions, "packageRoot" | "configDirectory" | "serviceRoot"> = {},
): WindowsRuntimeServiceStatus {
  assertWindows();
  endWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK);
  return windowsRuntimeServiceStatus(options);
}

export function rollbackWindowsRuntimeService(
  options: Pick<InstallWindowsRuntimeServiceOptions, "packageRoot" | "configDirectory" | "serviceRoot"> = {},
): WindowsRuntimeServiceStatus {
  assertWindows();
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const paths = windowsRuntimeServicePaths(options.serviceRoot);
  if (!existsSync(paths.previousTaskXmlPath) || !existsSync(paths.previousScriptPath)) {
    throw new Error("No previous Flyto2 Runtime Windows task is available for rollback.");
  }

  endWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK);
  copyFileSync(paths.previousTaskXmlPath, paths.taskXmlPath);
  copyFileSync(paths.previousScriptPath, paths.scriptPath);
  registerWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK, paths.taskXmlPath);
  runWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK);
  const healthUrl = runtimeHealthUrl(configDirectory);
  if (!waitForRuntimeHealth(healthUrl, 12_000, 150)) {
    throw new Error("Previous Flyto2 Runtime Windows task did not pass /healthz.");
  }
  copyFileSync(paths.taskXmlPath, paths.activeTaskXmlPath);
  return windowsRuntimeServiceStatus({
    packageRoot,
    configDirectory,
    serviceRoot: paths.serviceRoot,
  });
}

export function uninstallWindowsRuntimeService(
  options: Pick<InstallWindowsRuntimeServiceOptions, "packageRoot" | "configDirectory" | "serviceRoot"> = {},
): WindowsRuntimeServiceStatus {
  assertWindows();
  endWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK);
  deleteWindowsScheduledTask(FLYTO2_RUNTIME_WINDOWS_TASK);
  const paths = windowsRuntimeServicePaths(options.serviceRoot);
  rmSync(paths.serviceRoot, { recursive: true, force: true });
  return windowsRuntimeServiceStatus(options);
}

export function windowsRuntimeServiceStatus(options: {
  packageRoot?: string;
  configDirectory?: string;
  serviceRoot?: string;
} = {}): WindowsRuntimeServiceStatus {
  const packageRoot = options.packageRoot ?? flyto2RuntimePackageRoot();
  const configDirectory = options.configDirectory ?? devspaceConfigDir();
  const paths = windowsRuntimeServicePaths(options.serviceRoot);
  if (platform() !== "win32") {
    return {
      supported: false,
      label: FLYTO2_RUNTIME_WINDOWS_TASK,
      installed: false,
      loaded: false,
      taskName: FLYTO2_RUNTIME_WINDOWS_TASK,
      taskXmlPath: paths.taskXmlPath,
      packageRoot,
      configDirectory,
    };
  }

  const installed = windowsScheduledTaskExists(FLYTO2_RUNTIME_WINDOWS_TASK);
  const loaded = installed && runtimeHealthCheck(runtimeHealthUrl(configDirectory));
  return {
    supported: true,
    label: FLYTO2_RUNTIME_WINDOWS_TASK,
    installed,
    loaded,
    state: loaded ? "running" : installed ? "ready" : "not-installed",
    taskName: FLYTO2_RUNTIME_WINDOWS_TASK,
    taskXmlPath: paths.taskXmlPath,
    packageRoot,
    configDirectory,
  };
}

function runtimeHealthUrl(configDirectory: string): string {
  const config = loadConfig({
    ...process.env,
    DEVSPACE_CONFIG_DIR: configDirectory,
    FLYTO2_RUNTIME_CONFIG_DIR: configDirectory,
  });
  const localHost = ["0.0.0.0", "::"].includes(config.host) ? "127.0.0.1" : config.host;
  const formattedHost = localHost.includes(":") ? `[${localHost}]` : localHost;
  return `http://${formattedHost}:${config.port}/healthz`;
}

function runtimeHealthCheck(url: string): boolean {
  const script = [
    "const url = process.argv[1];",
    "fetch(url, { signal: AbortSignal.timeout(800), cache: 'no-store' })",
    "  .then(async (response) => {",
    "    if (!response.ok) process.exit(1);",
    "    const body = await response.json();",
    "    process.exit(body?.ok === true && body?.name === 'flyto2-runtime' ? 0 : 1);",
    "  })",
    "  .catch(() => process.exit(1));",
  ].join("\n");
  return spawnSync(process.execPath, ["-e", script, url], {
    encoding: "utf8",
    timeout: 1_000,
    windowsHide: true,
  }).status === 0;
}

function waitForRuntimeHealth(url: string, timeoutMs: number, intervalMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  do {
    if (runtimeHealthCheck(url)) return true;
    sleepSync(intervalMs);
  } while (Date.now() < deadline);
  return runtimeHealthCheck(url);
}

function waitForRuntimeStop(url: string, timeoutMs: number, intervalMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!runtimeHealthCheck(url)) return true;
    sleepSync(intervalMs);
  } while (Date.now() < deadline);
  return !runtimeHealthCheck(url);
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(winPath.dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

function powershellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function assertWindows(): void {
  if (platform() !== "win32") {
    throw new Error("Flyto2 Runtime Windows service management is available on Windows only.");
  }
}

// Runs a job once under Task Scheduler rather than as our child, so it survives
// the Runtime task being ended and restarted underneath it.
export function startWindowsOneShotTask(options: {
  taskName: string;
  xmlPath: string;
  command: string;
  arguments: string[];
  workingDirectory: string;
  // true: start at every logon and restart on failure (a long-lived helper).
  persistent?: boolean;
}): void {
  const xml = renderWindowsScheduledTaskXml({
    command: options.command,
    arguments: options.arguments.map(quoteWindowsArgument).join(" "),
    workingDirectory: options.workingDirectory,
    logonTrigger: options.persistent === true,
    restartCount: options.persistent ? 255 : 1,
  });
  mkdirSync(winPath.dirname(options.xmlPath), { recursive: true });
  writeFileSync(options.xmlPath, xml, "utf8");
  registerWindowsScheduledTask(options.taskName, options.xmlPath);
  runWindowsScheduledTask(options.taskName);
}

export function stopWindowsTask(taskName: string): void {
  endWindowsScheduledTask(taskName);
  if (windowsScheduledTaskExists(taskName)) deleteWindowsScheduledTask(taskName);
}
