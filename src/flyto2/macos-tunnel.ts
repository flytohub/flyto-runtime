import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { restartLaunchAgentWithRecovery } from "./macos-service.js";

export const FLYTO2_RUNTIME_TUNNEL_LABEL = "local.flyto2.runtime.tunnel";
export const FLYTO2_RUNTIME_TUNNEL_STANDBY_LABEL = "local.flyto2.runtime.tunnel.standby";

interface TunnelConnectorSpec {
  label: string;
  metricsPort: number;
  logSuffix: string;
}

const TUNNEL_CONNECTORS: readonly TunnelConnectorSpec[] = [
  { label: FLYTO2_RUNTIME_TUNNEL_LABEL, metricsPort: 20_241, logSuffix: "" },
  { label: FLYTO2_RUNTIME_TUNNEL_STANDBY_LABEL, metricsPort: 20_242, logSuffix: "-standby" },
];

interface LegacyMacKitSettings {
  cloudflared?: unknown;
  tunnel?: {
    hostname?: unknown;
    id?: unknown;
    configFile?: unknown;
  };
}

interface CloudflareTunnelConfig {
  tunnel?: unknown;
  "credentials-file"?: unknown;
  ingress?: unknown;
}

export interface NativeTunnelProfile {
  provider: "cloudflare";
  hostname: string;
  tunnel_id: string;
  binary_path: string;
  config_path: string;
  credentials_path: string;
  migrated_at: string;
}

export interface NativeTunnelConnectorStatus {
  label: string;
  loaded: boolean;
  state?: string;
  pid?: number;
  lastExitStatus?: number;
  metrics_url: string;
  plist_path: string;
}

export interface NativeTunnelStatus {
  supported: boolean;
  configured: boolean;
  loaded: boolean;
  label: string;
  state?: string;
  pid?: number;
  lastExitStatus?: number;
  hostname?: string;
  tunnel_id?: string;
  connector_count: number;
  running_connectors: number;
  redundant: boolean;
  connectors: NativeTunnelConnectorStatus[];
  profile_path: string;
  plist_path: string;
}

export function flyto2NativeRuntimeHome(
  homeDirectory = homedir(),
): string {
  return join(
    homeDirectory,
    "Library",
    "Application Support",
    "Flyto2 Runtime",
  );
}

export function nativeTunnelProfilePath(
  homeDirectory = homedir(),
): string {
  return join(flyto2NativeRuntimeHome(homeDirectory), "tunnel", "profile.json");
}

export function nativeTunnelPlistPath(
  homeDirectory = homedir(),
  label = FLYTO2_RUNTIME_TUNNEL_LABEL,
): string {
  return join(
    homeDirectory,
    "Library",
    "LaunchAgents",
    `${label}.plist`,
  );
}

export function migrateLegacyCloudflareTunnel(
  legacyConfigDirectory: string,
  homeDirectory = homedir(),
): NativeTunnelProfile {
  assertMacOs();
  const settingsPath = join(
    legacyConfigDirectory,
    "mac-kit",
    "settings.json",
  );
  if (!existsSync(settingsPath)) {
    throw new Error(`Legacy Mac Kit settings not found: ${settingsPath}`);
  }

  const settings = JSON.parse(
    readFileSync(settingsPath, "utf8"),
  ) as LegacyMacKitSettings;
  const binaryPath = requiredPath(settings.cloudflared, "cloudflared");
  const hostname = requiredString(settings.tunnel?.hostname, "tunnel.hostname");
  const tunnelId = requiredString(settings.tunnel?.id, "tunnel.id");
  const configPath = requiredPath(settings.tunnel?.configFile, "tunnel.configFile");
  if (!existsSync(binaryPath)) {
    throw new Error(`Legacy cloudflared binary not found: ${binaryPath}`);
  }
  if (!existsSync(configPath)) {
    throw new Error(`Legacy Cloudflare tunnel config not found: ${configPath}`);
  }

  const config = JSON.parse(
    readFileSync(configPath, "utf8"),
  ) as CloudflareTunnelConfig;
  const credentialsPath = requiredPath(
    config["credentials-file"],
    "credentials-file",
  );
  if (!existsSync(credentialsPath)) {
    throw new Error(
      `Legacy Cloudflare tunnel credentials not found: ${credentialsPath}`,
    );
  }

  const tunnelDirectory = join(
    flyto2NativeRuntimeHome(homeDirectory),
    "tunnel",
  );
  mkdirSync(tunnelDirectory, { recursive: true, mode: 0o700 });
  const nativeBinary = join(tunnelDirectory, "cloudflared");
  const nativeCredentials = join(tunnelDirectory, "credentials.json");
  const nativeConfig = join(tunnelDirectory, "config.json");
  const profilePath = nativeTunnelProfilePath(homeDirectory);

  copyFileSync(binaryPath, nativeBinary);
  chmodSync(nativeBinary, 0o700);
  copyFileSync(credentialsPath, nativeCredentials);
  chmodSync(nativeCredentials, 0o600);

  const migratedConfig: CloudflareTunnelConfig = {
    ...config,
    tunnel: tunnelId,
    "credentials-file": nativeCredentials,
  };
  writeAtomic(
    nativeConfig,
    JSON.stringify(migratedConfig, null, 2) + "\n",
    0o600,
  );

  const profile: NativeTunnelProfile = {
    provider: "cloudflare",
    hostname,
    tunnel_id: tunnelId,
    binary_path: nativeBinary,
    config_path: nativeConfig,
    credentials_path: nativeCredentials,
    migrated_at: new Date().toISOString(),
  };
  writeAtomic(profilePath, JSON.stringify(profile, null, 2) + "\n", 0o600);
  return profile;
}

export function loadNativeTunnelProfile(
  homeDirectory = homedir(),
): NativeTunnelProfile | undefined {
  const path = nativeTunnelProfilePath(homeDirectory);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<NativeTunnelProfile>;
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
  return value as NativeTunnelProfile;
}

export function renderNativeTunnelLaunchAgent(
  profile: NativeTunnelProfile,
  homeDirectory = homedir(),
  connector: TunnelConnectorSpec = TUNNEL_CONNECTORS[0]!,
): string {
  const logsDirectory = join(
    homeDirectory,
    "Library",
    "Logs",
    "Flyto2 Runtime",
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(connector.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(profile.binary_path)}</string>`,
    "    <string>tunnel</string>",
    "    <string>--config</string>",
    `    <string>${xmlEscape(profile.config_path)}</string>`,
    "    <string>--no-autoupdate</string>",
    "    <string>--protocol</string>",
    "    <string>http2</string>",
    "    <string>--metrics</string>",
    `    <string>127.0.0.1:${connector.metricsPort}</string>`,
    "    <string>run</string>",
    `    <string>${xmlEscape(profile.tunnel_id)}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>1</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(join(logsDirectory, `tunnel${connector.logSuffix}.log`))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(join(logsDirectory, `tunnel${connector.logSuffix}-error.log`))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function installNativeTunnelService(
  homeDirectory = homedir(),
  start = true,
): NativeTunnelStatus {
  assertMacOs();
  const profile = requireNativeTunnelProfile(homeDirectory);
  assertTunnelAssets(profile);

  const logsDirectory = join(
    homeDirectory,
    "Library",
    "Logs",
    "Flyto2 Runtime",
  );
  mkdirSync(
    dirname(nativeTunnelPlistPath(homeDirectory)),
    { recursive: true, mode: 0o700 },
  );
  mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });

  const staged = TUNNEL_CONNECTORS.map((connector) =>
    stageTunnelConnector(profile, homeDirectory, connector)
  );

  if (start) {
    for (const connector of [...staged].reverse()) {
      ensureTunnelConnector(homeDirectory, connector.spec, connector.requiresReload);
    }
  }
  return nativeTunnelStatus(homeDirectory);
}

export function stopNativeTunnelService(
  homeDirectory = homedir(),
): NativeTunnelStatus {
  assertMacOs();
  for (const connector of [...TUNNEL_CONNECTORS].reverse()) {
    bootoutConnector(connector.label);
  }
  return nativeTunnelStatus(homeDirectory);
}

export function startNativeTunnelService(
  homeDirectory = homedir(),
): NativeTunnelStatus {
  assertMacOs();
  if (
    TUNNEL_CONNECTORS.some((connector) =>
      !existsSync(nativeTunnelPlistPath(homeDirectory, connector.label))
    )
  ) {
    return installNativeTunnelService(homeDirectory, true);
  }

  for (const connector of [...TUNNEL_CONNECTORS].reverse()) {
    ensureTunnelConnector(homeDirectory, connector);
  }
  return nativeTunnelStatus(homeDirectory);
}

export function nativeTunnelStatus(
  homeDirectory = homedir(),
): NativeTunnelStatus {
  const profile = loadNativeTunnelProfile(homeDirectory);
  const connectors = TUNNEL_CONNECTORS.map((connector) =>
    tunnelConnectorStatus(homeDirectory, connector)
  );
  const primary = connectors[0]!;
  const runningConnectors = connectors.filter(
    (connector) => connector.pid !== undefined,
  ).length;
  const plistPath = nativeTunnelPlistPath(homeDirectory);

  return {
    supported: platform() === "darwin",
    configured: profile !== undefined,
    loaded: primary.loaded,
    label: FLYTO2_RUNTIME_TUNNEL_LABEL,
    ...(primary.state ? { state: primary.state } : {}),
    ...(primary.pid !== undefined ? { pid: primary.pid } : {}),
    ...(primary.lastExitStatus !== undefined
      ? { lastExitStatus: primary.lastExitStatus }
      : {}),
    ...(profile
      ? { hostname: profile.hostname, tunnel_id: profile.tunnel_id }
      : {}),
    connector_count: connectors.length,
    running_connectors: runningConnectors,
    redundant: runningConnectors >= 2,
    connectors,
    profile_path: nativeTunnelProfilePath(homeDirectory),
    plist_path: plistPath,
  };
}

function requireNativeTunnelProfile(homeDirectory: string): NativeTunnelProfile {
  const profile = loadNativeTunnelProfile(homeDirectory);
  if (!profile) {
    throw new Error("Flyto2 Runtime tunnel profile is not configured.");
  }
  return profile;
}

function assertTunnelAssets(profile: NativeTunnelProfile): void {
  for (const path of [
    profile.binary_path,
    profile.config_path,
    profile.credentials_path,
  ]) {
    if (!existsSync(path)) throw new Error(`Tunnel asset is missing: ${path}`);
  }
}

function stageTunnelConnector(
  profile: NativeTunnelProfile,
  homeDirectory: string,
  spec: TunnelConnectorSpec,
): { spec: TunnelConnectorSpec; requiresReload: boolean } {
  const plistPath = nativeTunnelPlistPath(homeDirectory, spec.label);
  const nextPlist = renderNativeTunnelLaunchAgent(profile, homeDirectory, spec);
  const previousPlistPath = `${plistPath}.previous`;
  const activePlistPath = `${plistPath}.active`;
  let requiresReload = false;

  if (existsSync(plistPath)) {
    const currentPlist = readFileSync(plistPath, "utf8");
    if (
      !existsSync(activePlistPath)
      && launchctlPrint(spec.label) !== undefined
    ) {
      copyFileSync(plistPath, activePlistPath);
    }
    if (currentPlist !== nextPlist) {
      copyFileSync(plistPath, previousPlistPath);
      requiresReload = true;
    }
  }

  writeAtomic(plistPath, nextPlist, 0o600);
  return { spec, requiresReload };
}

function ensureTunnelConnector(
  homeDirectory: string,
  spec: TunnelConnectorSpec,
  forceReload = false,
): void {
  const plistPath = nativeTunnelPlistPath(homeDirectory, spec.label);
  const activePlistPath = `${plistPath}.active`;
  const detail = launchctlPrint(spec.label);
  const activePlistMatches = !existsSync(activePlistPath)
    || readFileSync(activePlistPath, "utf8") === readFileSync(plistPath, "utf8");

  if (
    !forceReload
    && detail?.pid !== undefined
    && activePlistMatches
    && tunnelConnectorReady(spec)
  ) {
    return;
  }
  reloadTunnelConnector(homeDirectory, spec);
}

function reloadTunnelConnector(
  homeDirectory: string,
  spec: TunnelConnectorSpec,
): void {
  const plistPath = nativeTunnelPlistPath(homeDirectory, spec.label);
  const previousPlistPath = `${plistPath}.previous`;
  const activePlistPath = `${plistPath}.active`;
  const hasPreviousPlist = existsSync(previousPlistPath);

  restartLaunchAgentWithRecovery({
    bootout: () => bootoutConnector(spec.label),
    isLoaded: () => launchctlPrint(spec.label) !== undefined,
    activate: () => activateTunnelConnector(spec.label, plistPath),
    isHealthy: () => tunnelConnectorReady(spec),
    rollback: () => {
      if (hasPreviousPlist) copyFileSync(previousPlistPath, plistPath);
    },
    sleep: sleepSync,
  }, {
    name: spec.label === FLYTO2_RUNTIME_TUNNEL_LABEL
      ? "Flyto2 Runtime tunnel"
      : "Flyto2 Runtime tunnel standby",
    healthDescription: "cloudflared /ready",
  });

  copyFileSync(plistPath, activePlistPath);
}

function activateTunnelConnector(label: string, plistPath: string): void {
  if (!launchctlPrint(label)) {
    runLaunchctl(["bootstrap", launchAgentDomain(), plistPath]);
  }
  runLaunchctl(["enable", launchAgentTarget(label)]);
  runLaunchctl(["kickstart", "-k", launchAgentTarget(label)]);
}

function tunnelConnectorReady(spec: TunnelConnectorSpec): boolean {
  if (launchctlPrint(spec.label)?.pid === undefined) return false;
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
  }).status === 0;
}

function tunnelConnectorStatus(
  homeDirectory: string,
  spec: TunnelConnectorSpec,
): NativeTunnelConnectorStatus {
  const detail = launchctlPrint(spec.label);
  return {
    label: spec.label,
    loaded: detail !== undefined,
    ...(detail?.state ? { state: detail.state } : {}),
    ...(detail?.pid !== undefined ? { pid: detail.pid } : {}),
    ...(detail?.lastExitStatus !== undefined
      ? { lastExitStatus: detail.lastExitStatus }
      : {}),
    metrics_url: `http://127.0.0.1:${spec.metricsPort}/ready`,
    plist_path: nativeTunnelPlistPath(homeDirectory, spec.label),
  };
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function bootoutConnector(label: string): void {
  if (!launchctlPrint(label)) return;
  runLaunchctl(["bootout", launchAgentTarget(label)]);
}

function launchctlPrint(label: string): {
  state?: string;
  pid?: number;
  lastExitStatus?: number;
} | undefined {
  if (platform() !== "darwin") return undefined;
  const result = spawnSync(
    "launchctl",
    ["print", launchAgentTarget(label)],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  const output = result.stdout ?? "";
  const state = /^\s*state = (.+)$/m.exec(output)?.[1]?.trim();
  const pidText = /^\s*pid = (\d+)$/m.exec(output)?.[1];
  const lastExitText = /^\s*last exit code = (-?\d+)$/m.exec(output)?.[1];
  return {
    ...(state ? { state } : {}),
    ...(pidText ? { pid: Number(pidText) } : {}),
    ...(lastExitText ? { lastExitStatus: Number(lastExitText) } : {}),
  };
}

function runLaunchctl(args: string[]): void {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (result.status === 0) return;
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Legacy Mac Kit ${field} is missing.`);
  }
  return value.trim();
}

function requiredPath(value: unknown, field: string): string {
  return requiredString(value, field);
}

function assertMacOs(): void {
  if (platform() !== "darwin") {
    throw new Error("Flyto2 Runtime tunnel service management is available on macOS only.");
  }
}

function writeAtomic(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
  chmodSync(path, mode);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
