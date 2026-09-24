import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gt as semverGt, valid as semverValid } from "semver";
import { flyto2RuntimePackageRoot } from "./macos-launcher.js";

// A packaged app carries its own Node, production dependencies and cloudflared,
// and has no source to rebuild. scripts/package-macos.sh writes this marker next
// to package.json; a source checkout or npm install has none.
export const DISTRIBUTION_FILE = "distribution.json";
// Installers are published by flytohub/flyto2, the distribution authority, not
// by this repository.
export const FLYTO2_RUNTIME_DOWNLOADS_URL = "https://github.com/flytohub/flyto2/blob/main/products/runtime/README.md";

export interface PackagedDistribution {
  kind: "macos-app";
  version: string;
  arch: string;
}

export function packagedDistribution(packageRoot = flyto2RuntimePackageRoot()): PackagedDistribution | undefined {
  const file = join(packageRoot, DISTRIBUTION_FILE);
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PackagedDistribution>;
  if (value.kind !== "macos-app" || typeof value.version !== "string" || typeof value.arch !== "string") {
    throw new Error(`${file} is not a valid Flyto2 Runtime distribution marker.`);
  }
  return { kind: value.kind, version: value.version, arch: value.arch };
}

export function bundledCloudflaredPath(packageRoot = flyto2RuntimePackageRoot()): string {
  return join(packageRoot, "vendor", "cloudflared");
}

// The background service and launchers point at this package root, so it must
// be a place that stays: not the mounted disk image, and not the read-only copy
// macOS runs an app from until the user moves it out of Downloads.
export function packagedLocationProblem(packageRoot: string): string | undefined {
  if (packageRoot.startsWith("/Volumes/")) {
    return "Flyto2 Runtime is running from the disk image. Drag it into Applications, eject the disk image, and open it from Applications.";
  }
  if (packageRoot.includes("/AppTranslocation/")) {
    return "macOS is running Flyto2 Runtime from a temporary copy. Move it into Applications and open it from there.";
  }
  return undefined;
}

// The app leaves out the Claude Agent SDK's bundled Claude Code (over 200 MB),
// so a packaged Runtime runs the user's own `claude`. Someone who turns on the
// Claude subagent has Claude Code installed already.
export const PACKAGED_CLAUDE_COMMAND = "claude";

// The packaged app cannot rebuild itself, so it tells the user when flyto2's
// stable channel points at a newer version. The channel pointer is the
// distribution contract; the repository-wide latest release is not.
export const FLYTO2_RUNTIME_STABLE_CHANNEL_URL =
  "https://raw.githubusercontent.com/flytohub/flyto2/main/products/runtime/stable.json";

export interface AvailableAppUpdate {
  version: string;
  url: string;
}

export function newerStableRelease(channel: unknown, currentVersion: string): AvailableAppUpdate | undefined {
  if (!channel || typeof channel !== "object") return undefined;
  const { product, state, version, release_url: url } = channel as Record<string, unknown>;
  if (product !== "runtime" || state !== "promoted" || typeof version !== "string" || typeof url !== "string") return undefined;
  if (!semverValid(version) || !semverValid(currentVersion) || !semverGt(version, currentVersion)) return undefined;
  if (!url.startsWith("https://github.com/flytohub/flyto2/releases/tag/")) return undefined;
  return { version, url };
}

export async function checkForAppUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AvailableAppUpdate | undefined> {
  try {
    const response = await fetchImpl(FLYTO2_RUNTIME_STABLE_CHANNEL_URL, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return undefined;
    return newerStableRelease(await response.json(), currentVersion);
  } catch {
    // Offline or unreachable: say nothing rather than delay the menu.
    return undefined;
  }
}
