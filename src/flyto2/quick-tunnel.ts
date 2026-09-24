import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";

// A Cloudflare quick tunnel gives a free public HTTPS URL without an account or
// a domain, which is what a first-time user has. The price is that the URL is
// random and changes whenever cloudflared restarts. Runtime therefore never
// assumes the URL it saved is still current: cloudflared reports the live
// hostname on its metrics server, and the Runtime service follows it.

export const QUICK_TUNNEL_METRICS_PORT = 20243;
const QUICK_TUNNEL_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/;

export interface QuickTunnelProfile {
  binary_path: string;
  metrics_port: number;
  origin_port: number;
}

export function quickTunnelProfilePath(runtimeHome: string): string {
  return join(runtimeHome, "quick-tunnel", "profile.json");
}

export function readQuickTunnelProfile(runtimeHome: string): QuickTunnelProfile | undefined {
  try {
    const value = JSON.parse(readFileSync(quickTunnelProfilePath(runtimeHome), "utf8")) as Partial<QuickTunnelProfile>;
    if (typeof value.binary_path !== "string" || typeof value.metrics_port !== "number" || typeof value.origin_port !== "number") {
      return undefined;
    }
    return value as QuickTunnelProfile;
  } catch {
    return undefined;
  }
}

export function writeQuickTunnelProfile(runtimeHome: string, profile: QuickTunnelProfile): void {
  const path = quickTunnelProfilePath(runtimeHome);
  mkdirSync(join(runtimeHome, "quick-tunnel"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function quickTunnelArguments(profile: Pick<QuickTunnelProfile, "metrics_port" | "origin_port">): string[] {
  return [
    "tunnel",
    "--no-autoupdate",
    "--metrics",
    `127.0.0.1:${profile.metrics_port}`,
    "--url",
    `http://127.0.0.1:${profile.origin_port}`,
  ];
}

export async function fetchQuickTunnelHostname(
  metricsPort: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${metricsPort}/quicktunnel`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return undefined;
    const body = await response.json() as { hostname?: unknown };
    return typeof body.hostname === "string" && QUICK_TUNNEL_HOST.test(body.hostname) ? body.hostname : undefined;
  } catch {
    return undefined;
  }
}

export async function waitForQuickTunnelHostname(
  metricsPort: number,
  { timeoutMs = 45_000, intervalMs = 1_000, fetchImpl = fetch, sleep = defaultSleep }: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hostname = await fetchQuickTunnelHostname(metricsPort, fetchImpl);
    if (hostname || Date.now() >= deadline) return hostname;
    await sleep(intervalMs);
  }
}

// Returns the public base URL to switch to, or undefined when the saved one is
// still right or cloudflared has not reported a hostname yet.
export function quickTunnelUrlChange(savedPublicBaseUrl: string, liveHostname: string | undefined): string | undefined {
  if (!liveHostname) return undefined;
  let savedHost: string | undefined;
  try {
    savedHost = new URL(savedPublicBaseUrl).hostname;
  } catch {
    savedHost = undefined;
  }
  return savedHost === liveHostname ? undefined : `https://${liveHostname}`;
}

// A first-time user has neither cloudflared nor Homebrew, so Runtime keeps its
// own copy of the official release in <runtime home>/bin, downloaded from
// Cloudflare's GitHub releases and accepted only when Cloudflare signed it.
// An existing install is used first: PATH, then the Homebrew and winget
// locations that launchd and double-clicked launchers do not have on PATH.
export const CLOUDFLARED_RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download";
// Cloudflare's Apple Developer ID team; the Windows build is signed by the same company.
export const CLOUDFLARE_APPLE_TEAM_ID = "68WVV388M8";

export function managedCloudflaredPath(runtimeHome: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? win32.join(runtimeHome, "bin", "cloudflared.exe")
    : posix.join(runtimeHome, "bin", "cloudflared");
}

export function cloudflaredCandidatePaths(
  platform: NodeJS.Platform,
  { runtimeHome, home, env = {} }: { runtimeHome: string; home: string; env?: NodeJS.ProcessEnv },
): string[] {
  const managed = managedCloudflaredPath(runtimeHome, platform);
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || win32.join(home, "AppData", "Local");
    return [
      managed,
      win32.join(localAppData, "Microsoft", "WinGet", "Links", "cloudflared.exe"),
      "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
      "C:\\Program Files\\cloudflared\\cloudflared.exe",
    ];
  }
  return [managed, "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", posix.join(home, ".local", "bin", "cloudflared")];
}

export function locateCloudflared(
  platform: NodeJS.Platform,
  onPath: () => string | undefined,
  locations: { runtimeHome: string; home: string; env?: NodeJS.ProcessEnv },
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return onPath() ?? cloudflaredCandidatePaths(platform, locations).find(exists);
}

// Someone who followed Cloudflare's own instructions has the release sitting in
// Downloads, extracted or not. It is copied into Runtime's bin rather than run
// from there: a background service reading ~/Downloads needs a privacy grant
// on macOS, and Downloads gets cleaned out.
export function downloadedCloudflaredCandidates(platform: NodeJS.Platform, home: string): string[] {
  if (platform === "win32") {
    const downloads = win32.join(home, "Downloads");
    return ["cloudflared-windows-amd64.exe", "cloudflared-windows-386.exe", "cloudflared.exe"].map((name) => win32.join(downloads, name));
  }
  const downloads = posix.join(home, "Downloads");
  return [
    "cloudflared",
    "cloudflared-darwin-arm64/cloudflared",
    "cloudflared-darwin-amd64/cloudflared",
    "cloudflared-darwin-arm64.tgz",
    "cloudflared-darwin-amd64.tgz",
  ].map((name) => posix.join(downloads, name));
}

// Windows on ARM runs the amd64 build; Cloudflare publishes no arm64 one.
export function cloudflaredReleaseAsset(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === "darwin") {
    if (arch === "arm64") return "cloudflared-darwin-arm64.tgz";
    if (arch === "x64") return "cloudflared-darwin-amd64.tgz";
    return undefined;
  }
  if (platform === "win32") {
    if (arch === "x64" || arch === "arm64") return "cloudflared-windows-amd64.exe";
    if (arch === "ia32") return "cloudflared-windows-386.exe";
  }
  return undefined;
}

// A new trycloudflare hostname takes a few seconds to appear in DNS. Every
// cache on the way keeps an early NXDOMAIN for the zone's negative TTL, 1800 s
// for trycloudflare.com: a caching resolver (8.8.8.8, an ISP's, a router's)
// and Node's own c-ares channel, which caches misses per Resolver. Retrying
// through either one fails for half an hour against a tunnel that works. So
// each attempt asks the zone's authoritative nameservers through a Resolver
// created for that attempt alone. Only once the record exists does anything
// go through the system resolver.
export function authoritativeResolve4(): (hostname: string) => Promise<string[]> {
  let nameserverAddresses: Promise<string[]> | undefined;
  return async (hostname) => {
    const dns = (await import("node:dns")).promises;
    nameserverAddresses ??= (async () => {
      const zone = hostname.slice(hostname.indexOf(".") + 1);
      const nameservers = await dns.resolveNs(zone);
      const addresses = (await Promise.all(nameservers.map((ns) => dns.resolve4(ns).catch(() => [])))).flat();
      if (addresses.length === 0) throw new Error(`No reachable nameserver for ${zone}.`);
      return addresses;
    })().catch((error: unknown) => {
      nameserverAddresses = undefined;
      throw error;
    });
    const authority = new dns.Resolver({ timeout: 2_000, tries: 1 });
    authority.setServers(await nameserverAddresses);
    return authority.resolve4(hostname);
  };
}

export async function waitForPublicDns(
  hostname: string,
  {
    timeoutMs = 30_000,
    intervalMs = 1_000,
    resolve = authoritativeResolve4(),
    // Networks that block direct DNS never reach the authority. By the deadline
    // the record normally exists, so one system lookup is safe to try then.
    fallbackResolve = async (name: string) => (await import("node:dns")).promises.resolve4(name),
    sleep = defaultSleep,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    resolve?: (name: string) => Promise<string[]>;
    fallbackResolve?: (name: string) => Promise<string[]>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await resolve(hostname)).length > 0) return;
    } catch {
      // Not published yet, or the authority is unreachable from here.
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  }
  try {
    if ((await fallbackResolve(hostname)).length > 0) return;
  } catch {
    // Fall through to the error below.
  }
  throw new Error(`Quick tunnel hostname ${hostname} did not appear in public DNS within ${timeoutMs} ms.`);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
