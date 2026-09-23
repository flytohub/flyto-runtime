import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { win32 as winPath } from "node:path";
import {
  endWindowsScheduledTask,
  queryWindowsScheduledTaskXml,
  registerWindowsScheduledTask,
  renderWindowsScheduledTaskXml,
  runWindowsScheduledTask,
  windowsScheduledTaskExists,
  windowsTaskPrincipal,
} from "./windows-task.js";

export const FLYTO2_RUNTIME_WINDOWS_TUNNEL_TASK = "Flyto2 Runtime Tunnel";
export const FLYTO2_RUNTIME_WINDOWS_TUNNEL_STANDBY_TASK = "Flyto2 Runtime Tunnel Standby";

export interface WindowsTunnelConnectorSpec {
  taskName: string;
  metricsPort: number;
  fileStem: string;
  protocol: "quic" | "http2";
}

export const WINDOWS_TUNNEL_CONNECTORS: readonly WindowsTunnelConnectorSpec[] = [
  {
    taskName: FLYTO2_RUNTIME_WINDOWS_TUNNEL_TASK,
    metricsPort: 20_241,
    fileStem: "tunnel-primary",
    protocol: "quic",
  },
  {
    taskName: FLYTO2_RUNTIME_WINDOWS_TUNNEL_STANDBY_TASK,
    metricsPort: 20_242,
    fileStem: "tunnel-standby",
    protocol: "http2",
  },
];

export interface WindowsNativeTunnelProfile {
  provider: "cloudflare";
  hostname: string;
  tunnel_id: string;
  binary_path: string;
  config_path: string;
  credentials_path: string;
  migrated_at: string;
}

export interface WindowsNativeTunnelReadiness {
  supported: boolean;
  configured: boolean;
  connector_count: number;
  ready_connectors: number;
  connectors: Array<{ label: string; ready: boolean }>;
}

export interface WindowsNativeTunnelStatus {
  supported: boolean;
  configured: boolean;
  loaded: boolean;
  label: string;
  hostname?: string;
  tunnel_id?: string;
  connector_count: number;
  running_connectors: number;
  redundant: boolean;
  connectors: Array<{
    label: string;
    loaded: boolean;
    state: string;
    metrics_url: string;
    task_xml_path: string;
  }>;
  profile_path: string;
}

export function windowsNativeRuntimeHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const localAppData = env.LOCALAPPDATA?.trim();
  return localAppData
    ? winPath.join(localAppData, "Flyto2 Runtime")
    : winPath.join(homeDirectory, "AppData", "Local", "Flyto2 Runtime");
}

export function windowsTunnelProfilePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const explicit = env.FLYTO2_RUNTIME_TUNNEL_PROFILE?.trim();
  if (explicit) return explicit;
  return winPath.join(windowsNativeRuntimeHome(env, homeDirectory), "tunnel", "profile.json");
}

export function loadWindowsTunnelProfile(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): WindowsNativeTunnelProfile | undefined {
  const path = windowsTunnelProfilePath(env, homeDirectory);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowsNativeTunnelProfile>;
  if (
    value.provider !== "cloudflare"
    || typeof value.hostname !== "string"
    || typeof value.tunnel_id !== "string"
    || typeof value.binary_path !== "string"
    || typeof value.config_path !== "string"
    || typeof value.credentials_path !== "string"
    || typeof value.migrated_at !== "string"
  ) {
    throw new Error(`Invalid Flyto2 Runtime tunnel profile: ${path}`);
  }
  return value as WindowsNativeTunnelProfile;
}

export function windowsTunnelTaskXmlPath(
  spec: WindowsTunnelConnectorSpec,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  return winPath.join(
    windowsNativeRuntimeHome(env, homeDirectory),
    "tunnel",
    `${spec.fileStem}.task.xml`,
  );
}

export function renderWindowsTunnelTask(
  profile: WindowsNativeTunnelProfile,
  spec: WindowsTunnelConnectorSpec,
  principal = windowsTaskPrincipal(),
): string {
  const args = [
    "tunnel",
    "--config",
    quoteWindowsArgument(profile.config_path),
    "--no-autoupdate",
    "--protocol",
    spec.protocol,
    "--metrics",
    `127.0.0.1:${spec.metricsPort}`,
    "run",
    profile.tunnel_id,
  ].join(" ");
  return renderWindowsScheduledTaskXml({
    command: profile.binary_path,
    arguments: args,
    workingDirectory: winPath.dirname(profile.binary_path),
    principal,
    logonTrigger: true,
    restartIntervalMinutes: 1,
    restartCount: 255,
  });
}

export function installWindowsTunnelService(
  start = true,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): WindowsNativeTunnelStatus {
  assertWindows();
  const profile = requireWindowsTunnelProfile(env, homeDirectory);
  assertTunnelAssets(profile);
  for (const spec of WINDOWS_TUNNEL_CONNECTORS) {
    const xmlPath = windowsTunnelTaskXmlPath(spec, env, homeDirectory);
    mkdirSync(winPath.dirname(xmlPath), { recursive: true });
    const previous = queryWindowsScheduledTaskXml(spec.taskName);
    if (previous) writeFileSync(`${xmlPath}.previous`, previous, "utf8");
    else if (existsSync(xmlPath)) copyFileSync(xmlPath, `${xmlPath}.previous`);
    writeAtomic(xmlPath, renderWindowsTunnelTask(profile, spec));
    registerWindowsScheduledTask(spec.taskName, xmlPath);
  }

  if (start) {
    for (const spec of [...WINDOWS_TUNNEL_CONNECTORS].reverse()) {
      restartWindowsTunnelConnector(spec, env, homeDirectory);
    }
  }
  return windowsNativeTunnelStatus(env, homeDirectory);
}

export function startWindowsTunnelService(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): WindowsNativeTunnelStatus {
  assertWindows();
  const profile = requireWindowsTunnelProfile(env, homeDirectory);
  assertTunnelAssets(profile);

  const missing = WINDOWS_TUNNEL_CONNECTORS.some(
    (spec) => !windowsScheduledTaskExists(spec.taskName)
      || !existsSync(windowsTunnelTaskXmlPath(spec, env, homeDirectory)),
  );
  if (missing) return installWindowsTunnelService(true, env, homeDirectory);

  for (const spec of [...WINDOWS_TUNNEL_CONNECTORS].reverse()) {
    if (!windowsTunnelConnectorReady(spec)) {
      restartWindowsTunnelConnector(spec, env, homeDirectory);
    }
  }
  return windowsNativeTunnelStatus(env, homeDirectory);
}

export function stopWindowsTunnelService(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): WindowsNativeTunnelStatus {
  assertWindows();
  for (const spec of [...WINDOWS_TUNNEL_CONNECTORS].reverse()) {
    endWindowsScheduledTask(spec.taskName);
  }
  return windowsNativeTunnelStatus(env, homeDirectory);
}

export async function windowsNativeTunnelReadiness(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): Promise<WindowsNativeTunnelReadiness> {
  const supported = platform() === "win32";
  const configured = loadWindowsTunnelProfile(env, homeDirectory) !== undefined;
  if (!supported || !configured) {
    return {
      supported,
      configured,
      connector_count: WINDOWS_TUNNEL_CONNECTORS.length,
      ready_connectors: 0,
      connectors: WINDOWS_TUNNEL_CONNECTORS.map((spec) => ({
        label: spec.taskName,
        ready: false,
      })),
    };
  }

  const connectors = await Promise.all(
    WINDOWS_TUNNEL_CONNECTORS.map(async (spec) => ({
      label: spec.taskName,
      ready: await windowsTunnelConnectorReadyAsync(spec),
    })),
  );
  return {
    supported,
    configured,
    connector_count: connectors.length,
    ready_connectors: connectors.filter((entry) => entry.ready).length,
    connectors,
  };
}

export function windowsNativeTunnelStatus(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): WindowsNativeTunnelStatus {
  const profile = loadWindowsTunnelProfile(env, homeDirectory);
  const connectors = WINDOWS_TUNNEL_CONNECTORS.map((spec) => {
    const installed = platform() === "win32" && windowsScheduledTaskExists(spec.taskName);
    const ready = installed && windowsTunnelConnectorReady(spec);
    return {
      label: spec.taskName,
      loaded: installed,
      state: ready ? "running" : installed ? "degraded" : "not-installed",
      metrics_url: `http://127.0.0.1:${spec.metricsPort}/ready`,
      task_xml_path: windowsTunnelTaskXmlPath(spec, env, homeDirectory),
    };
  });
  const ready = connectors.filter((connector) => connector.state === "running").length;
  return {
    supported: platform() === "win32",
    configured: profile !== undefined,
    loaded: connectors.some((connector) => connector.loaded),
    label: FLYTO2_RUNTIME_WINDOWS_TUNNEL_TASK,
    ...(profile ? { hostname: profile.hostname, tunnel_id: profile.tunnel_id } : {}),
    connector_count: connectors.length,
    running_connectors: ready,
    redundant: ready >= 2,
    connectors,
    profile_path: windowsTunnelProfilePath(env, homeDirectory),
  };
}

function restartWindowsTunnelConnector(
  spec: WindowsTunnelConnectorSpec,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): void {
  const xmlPath = windowsTunnelTaskXmlPath(spec, env, homeDirectory);
  try {
    endWindowsScheduledTask(spec.taskName);
    runWindowsScheduledTask(spec.taskName);
    if (!waitForTunnelReady(spec, 10_000, 200)) {
      throw new Error(`${spec.taskName} did not become ready.`);
    }
    copyFileSync(xmlPath, `${xmlPath}.active`);
  } catch (restartError) {
    const previous = `${xmlPath}.previous`;
    if (!existsSync(previous)) throw restartError;
    try {
      endWindowsScheduledTask(spec.taskName);
      copyFileSync(previous, xmlPath);
      registerWindowsScheduledTask(spec.taskName, xmlPath);
      runWindowsScheduledTask(spec.taskName);
      if (!waitForTunnelReady(spec, 10_000, 200)) {
        throw new Error(`Previous ${spec.taskName} task did not recover.`);
      }
      copyFileSync(xmlPath, `${xmlPath}.active`);
    } catch (rollbackError) {
      throw new AggregateError(
        [restartError, rollbackError],
        `${spec.taskName} restart and automatic rollback both failed.`,
      );
    }
    throw new Error(
      `${spec.taskName} restart failed and the previous task was restored: ${errorMessage(restartError)}`,
      { cause: restartError },
    );
  }
}

async function windowsTunnelConnectorReadyAsync(
  spec: WindowsTunnelConnectorSpec,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${spec.metricsPort}/ready`, {
      signal: AbortSignal.timeout(800),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const body = await response.json() as { readyConnections?: unknown };
    return Number(body.readyConnections ?? 0) > 0;
  } catch {
    return false;
  }
}

function windowsTunnelConnectorReady(spec: WindowsTunnelConnectorSpec): boolean {
  if (platform() !== "win32") return false;
  const url = `http://127.0.0.1:${spec.metricsPort}/ready`;
  const script = [
    "const url = process.argv[1];",
    "fetch(url, { signal: AbortSignal.timeout(800), cache: 'no-store' })",
    "  .then(async (response) => {",
    "    if (!response.ok) process.exit(1);",
    "    const body = await response.json();",
    "    process.exit(Number(body?.readyConnections ?? 0) > 0 ? 0 : 1);",
    "  })",
    "  .catch(() => process.exit(1));",
  ].join("\n");
  return spawnSync(process.execPath, ["-e", script, url], {
    encoding: "utf8",
    timeout: 1_000,
    windowsHide: true,
  }).status === 0;
}

function waitForTunnelReady(
  spec: WindowsTunnelConnectorSpec,
  timeoutMs: number,
  intervalMs: number,
): boolean {
  const deadline = Date.now() + timeoutMs;
  do {
    if (windowsTunnelConnectorReady(spec)) return true;
    sleepSync(intervalMs);
  } while (Date.now() < deadline);
  return windowsTunnelConnectorReady(spec);
}

function requireWindowsTunnelProfile(
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): WindowsNativeTunnelProfile {
  const profile = loadWindowsTunnelProfile(env, homeDirectory);
  if (!profile) {
    throw new Error(
      `Flyto2 Runtime tunnel profile is not configured at ${windowsTunnelProfilePath(env, homeDirectory)}.`,
    );
  }
  return profile;
}

function assertTunnelAssets(profile: WindowsNativeTunnelProfile): void {
  for (const path of [
    profile.binary_path,
    profile.config_path,
    profile.credentials_path,
  ]) {
    if (!existsSync(path)) throw new Error(`Tunnel asset is missing: ${path}`);
  }
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(winPath.dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
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
    throw new Error("Flyto2 Runtime Windows tunnel management is available on Windows only.");
  }
}
