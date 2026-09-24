import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

// cloudflared is often installed by Homebrew, whose bin directory is missing
// from the PATH launchd and double-clicked launchers inherit.
export function cloudflaredCandidatePaths(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return [
      "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
      "C:\\Program Files\\cloudflared\\cloudflared.exe",
    ];
  }
  return ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];
}

export function locateCloudflared(
  platform: NodeJS.Platform,
  onPath: () => string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return onPath() ?? cloudflaredCandidatePaths(platform).find(exists);
}

export function cloudflaredInstallCommand(
  platform: NodeJS.Platform,
  has: (command: string) => boolean,
): { command: string; args: string[] } | undefined {
  if (platform === "darwin" && has("brew")) return { command: "brew", args: ["install", "cloudflared"] };
  if (platform === "win32" && has("winget")) {
    return {
      command: "winget",
      args: ["install", "--id", "Cloudflare.cloudflared", "--exact", "--accept-source-agreements", "--accept-package-agreements"],
    };
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
