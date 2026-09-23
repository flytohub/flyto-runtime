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
import { posix, win32 } from "node:path";
import YAML from "yaml";
import { flyto2NativeRuntimeHome } from "./native-paths.js";

export interface ImportedNativeTunnelProfile {
  provider: "cloudflare";
  hostname: string;
  tunnel_id: string;
  binary_path: string;
  config_path: string;
  credentials_path: string;
  migrated_at: string;
}

interface CloudflareConfig {
  tunnel?: unknown;
  "credentials-file"?: unknown;
  ingress?: unknown;
  [key: string]: unknown;
}

export interface ImportCloudflareTunnelOptions {
  configPath: string;
  binaryPath?: string;
  hostname?: string;
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
  currentPlatform?: NodeJS.Platform;
}

export function importCloudflareTunnel(
  options: ImportCloudflareTunnelOptions,
): ImportedNativeTunnelProfile {
  const currentPlatform = options.currentPlatform ?? platform();
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const pathApi = currentPlatform === "win32" ? win32 : posix;
  const sourceConfigPath = pathApi.resolve(options.configPath);
  if (!existsSync(sourceConfigPath)) {
    throw new Error(`Cloudflare tunnel config not found: ${sourceConfigPath}`);
  }

  const config = parseCloudflareConfig(readFileSync(sourceConfigPath, "utf8"));
  const tunnelId = requiredString(config.tunnel, "tunnel");
  const sourceCredentials = resolveConfigPath(
    requiredString(config["credentials-file"], "credentials-file"),
    sourceConfigPath,
    homeDirectory,
    pathApi,
  );
  if (!existsSync(sourceCredentials)) {
    throw new Error(`Cloudflare tunnel credentials not found: ${sourceCredentials}`);
  }

  const hostname = options.hostname?.trim() || ingressHostname(config.ingress);
  if (!hostname) {
    throw new Error(
      "Cloudflare tunnel hostname was not found in ingress. Pass the hostname explicitly.",
    );
  }

  const sourceBinary = options.binaryPath
    ? pathApi.resolve(options.binaryPath)
    : findCloudflaredBinary(currentPlatform, env);
  if (!sourceBinary || !existsSync(sourceBinary)) {
    throw new Error(
      "cloudflared was not found. Install it or pass its executable path.",
    );
  }

  const runtimeHome = flyto2NativeRuntimeHome(
    homeDirectory,
    env,
    currentPlatform,
  );
  const tunnelDirectory = pathApi.join(runtimeHome, "tunnel");
  mkdirSync(tunnelDirectory, { recursive: true });

  const binaryName = currentPlatform === "win32" ? "cloudflared.exe" : "cloudflared";
  const nativeBinary = pathApi.join(tunnelDirectory, binaryName);
  const nativeCredentials = pathApi.join(tunnelDirectory, "credentials.json");
  const nativeConfig = pathApi.join(tunnelDirectory, "config.yml");
  const profilePath = pathApi.join(tunnelDirectory, "profile.json");

  copyFileSync(sourceBinary, nativeBinary);
  copyFileSync(sourceCredentials, nativeCredentials);
  if (currentPlatform !== "win32") {
    chmodSync(nativeBinary, 0o700);
    chmodSync(nativeCredentials, 0o600);
  }

  const nativeConfigValue: CloudflareConfig = {
    ...config,
    tunnel: tunnelId,
    "credentials-file": nativeCredentials,
  };
  writeAtomic(
    nativeConfig,
    YAML.stringify(nativeConfigValue),
    currentPlatform === "win32" ? undefined : 0o600,
  );

  const profile: ImportedNativeTunnelProfile = {
    provider: "cloudflare",
    hostname,
    tunnel_id: tunnelId,
    binary_path: nativeBinary,
    config_path: nativeConfig,
    credentials_path: nativeCredentials,
    migrated_at: new Date().toISOString(),
  };
  writeAtomic(
    profilePath,
    JSON.stringify(profile, null, 2) + "\n",
    currentPlatform === "win32" ? undefined : 0o600,
  );
  return profile;
}

export function findCloudflaredBinary(
  currentPlatform: NodeJS.Platform = platform(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const command = currentPlatform === "win32" ? "where.exe" : "which";
  const executable = currentPlatform === "win32" ? "cloudflared.exe" : "cloudflared";
  const result = spawnSync(command, [executable], {
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function parseCloudflareConfig(content: string): CloudflareConfig {
  const value = YAML.parse(content) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloudflare tunnel config must be a YAML/JSON object.");
  }
  return value as CloudflareConfig;
}

function ingressHostname(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const hostname = (entry as { hostname?: unknown }).hostname;
    if (typeof hostname === "string" && hostname.trim()) return hostname.trim();
  }
  return undefined;
}

function resolveConfigPath(
  value: string,
  configPath: string,
  homeDirectory: string,
  pathApi: typeof posix | typeof win32,
): string {
  let candidate = value;
  if (candidate === "~") candidate = homeDirectory;
  else if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = pathApi.join(homeDirectory, candidate.slice(2));
  }
  return pathApi.isAbsolute(candidate)
    ? candidate
    : pathApi.resolve(pathApi.dirname(configPath), candidate);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Cloudflare tunnel config field ${field} is missing.`);
  }
  return value.trim();
}

function writeAtomic(path: string, content: string, mode?: number): void {
  const pathApi = path.includes("\\") ? win32 : posix;
  mkdirSync(pathApi.dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(
    temporary,
    content,
    mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode },
  );
  renameSync(temporary, path);
  if (mode !== undefined) chmodSync(path, mode);
}
