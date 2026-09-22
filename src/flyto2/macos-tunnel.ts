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
): string {
  return join(
    homeDirectory,
    "Library",
    "LaunchAgents",
    `${FLYTO2_RUNTIME_TUNNEL_LABEL}.plist`,
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
    `  <string>${FLYTO2_RUNTIME_TUNNEL_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(profile.binary_path)}</string>`,
    "    <string>tunnel</string>",
    "    <string>--config</string>",
    `    <string>${xmlEscape(profile.config_path)}</string>`,
    "    <string>--no-autoupdate</string>",
    "    <string>--protocol</string>",
    "    <string>http2</string>",
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
    `  <string>${xmlEscape(join(logsDirectory, "tunnel.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(join(logsDirectory, "tunnel-error.log"))}</string>`,
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
  const profile = loadNativeTunnelProfile(homeDirectory);
  if (!profile) {
    throw new Error("Flyto2 Runtime tunnel profile is not configured.");
  }
  for (const path of [
    profile.binary_path,
    profile.config_path,
    profile.credentials_path,
  ]) {
    if (!existsSync(path)) throw new Error(`Tunnel asset is missing: ${path}`);
  }

  const plistPath = nativeTunnelPlistPath(homeDirectory);
  const logsDirectory = join(
    homeDirectory,
    "Library",
    "Logs",
    "Flyto2 Runtime",
  );
  mkdirSync(dirname(plistPath), { recursive: true, mode: 0o700 });
  mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
  const nextPlist = renderNativeTunnelLaunchAgent(profile, homeDirectory);
  const previousPlistPath = `${plistPath}.previous`;
  const activePlistPath = `${plistPath}.active`;
  let requiresReload = false;

  if (existsSync(plistPath)) {
    const currentPlist = readFileSync(plistPath, "utf8");
    if (
      !existsSync(activePlistPath)
      && launchctlPrint() !== undefined
    ) {
      copyFileSync(plistPath, activePlistPath);
    }
    if (currentPlist !== nextPlist) {
      copyFileSync(plistPath, previousPlistPath);
      requiresReload = true;
    }
  }

  writeAtomic(plistPath, nextPlist, 0o600);

  if (start) {
    if (requiresReload) return reloadNativeTunnelService(homeDirectory);
    return startNativeTunnelService(homeDirectory);
  }
  return nativeTunnelStatus(homeDirectory);
}

export function stopNativeTunnelService(
  homeDirectory = homedir(),
): NativeTunnelStatus {
  assertMacOs();
  bootout();
  return nativeTunnelStatus(homeDirectory);
}

export function startNativeTunnelService(
  homeDirectory = homedir(),
): NativeTunnelStatus {
  assertMacOs();
  const plistPath = nativeTunnelPlistPath(homeDirectory);
  if (!existsSync(plistPath)) return installNativeTunnelService(homeDirectory, true);
  const detail = launchctlPrint();
  const activePlistPath = `${plistPath}.active`;
  const activePlistMatches = !existsSync(activePlistPath)
    || readFileSync(activePlistPath, "utf8") === readFileSync(plistPath, "utf8");

  if (detail?.pid !== undefined && activePlistMatches) {
    return nativeTunnelStatus(homeDirectory);
  }
  return reloadNativeTunnelService(homeDirectory);
}

export function nativeTunnelStatus(
  homeDirectory = homedir(),
): NativeTunnelStatus {
  const profile = loadNativeTunnelProfile(homeDirectory);
  const plistPath = nativeTunnelPlistPath(homeDirectory);
  if (platform() !== "darwin") {
    return {
      supported: false,
      configured: profile !== undefined,
      loaded: false,
      label: FLYTO2_RUNTIME_TUNNEL_LABEL,
      profile_path: nativeTunnelProfilePath(homeDirectory),
      plist_path: plistPath,
      ...(profile
        ? { hostname: profile.hostname, tunnel_id: profile.tunnel_id }
        : {}),
    };
  }
  const detail = launchctlPrint();
  return {
    supported: true,
    configured: profile !== undefined,
    loaded: detail !== undefined,
    label: FLYTO2_RUNTIME_TUNNEL_LABEL,
    ...(detail?.state ? { state: detail.state } : {}),
    ...(detail?.pid !== undefined ? { pid: detail.pid } : {}),
    ...(detail?.lastExitStatus !== undefined
      ? { lastExitStatus: detail.lastExitStatus }
      : {}),
    ...(profile
      ? { hostname: profile.hostname, tunnel_id: profile.tunnel_id }
      : {}),
    profile_path: nativeTunnelProfilePath(homeDirectory),
    plist_path: plistPath,
  };
}

function reloadNativeTunnelService(
  homeDirectory = homedir(),
): NativeTunnelStatus {
  const plistPath = nativeTunnelPlistPath(homeDirectory);
  const previousPlistPath = `${plistPath}.previous`;
  const activePlistPath = `${plistPath}.active`;
  const hasPreviousPlist = existsSync(previousPlistPath);

  restartLaunchAgentWithRecovery({
    bootout,
    isLoaded: () => launchctlPrint() !== undefined,
    activate: () => activateNativeTunnelLaunchAgent(plistPath),
    isHealthy: tunnelProcessHealthy,
    rollback: () => {
      if (hasPreviousPlist) {
        copyFileSync(previousPlistPath, plistPath);
      }
    },
    sleep: sleepSync,
  }, {
    name: "Flyto2 Runtime tunnel",
    healthDescription: "launchd process check",
  });

  copyFileSync(plistPath, activePlistPath);
  return nativeTunnelStatus(homeDirectory);
}

function activateNativeTunnelLaunchAgent(plistPath: string): void {
  if (!launchctlPrint()) {
    runLaunchctl(["bootstrap", launchAgentDomain(), plistPath]);
  }
  runLaunchctl(["enable", launchAgentTarget()]);
  runLaunchctl(["kickstart", "-k", launchAgentTarget()]);
}

function tunnelProcessHealthy(): boolean {
  const detail = launchctlPrint();
  return detail?.pid !== undefined;
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

function bootout(): void {
  if (!launchctlPrint()) return;
  runLaunchctl(["bootout", launchAgentTarget()]);
}

function launchctlPrint(): {
  state?: string;
  pid?: number;
  lastExitStatus?: number;
} | undefined {
  if (platform() !== "darwin") return undefined;
  const result = spawnSync(
    "launchctl",
    ["print", launchAgentTarget()],
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

function launchAgentTarget(): string {
  return `${launchAgentDomain()}/${FLYTO2_RUNTIME_TUNNEL_LABEL}`;
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
