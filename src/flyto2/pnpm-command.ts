import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { flyto2RuntimePackageRoot } from "./macos-launcher.js";
import { commandExists } from "./quick-tunnel-service.js";

// A first-time user has Node but rarely pnpm, and `corepack enable` cannot help
// most of them: it writes shims next to node, which is root-owned for the
// nodejs.org installer, and Node 25+ no longer ships corepack at all. So pnpm
// is found, never installed: a pnpm on PATH, else corepack running the pinned
// version without enabling anything, else npm fetching the pinned version.
// The launchers (`Flyto2 Runtime.command` / `.cmd`) resolve it the same way.
export function pnpmInvocation(options: {
  platform: NodeJS.Platform;
  has: (command: string) => boolean;
  version: string;
}): string[] | undefined {
  const shim = (name: string) => (options.platform === "win32" ? `${name}.cmd` : name);
  if (options.has(shim("pnpm"))) return [shim("pnpm")];
  if (options.has(shim("corepack"))) return [shim("corepack"), "pnpm"];
  if (options.has(shim("npm"))) return [shim("npm"), "exec", "--yes", `--package=pnpm@${options.version}`, "--", "pnpm"];
  return undefined;
}

export function pinnedPnpmVersion(packageManager: unknown): string {
  const match = typeof packageManager === "string" ? /^pnpm@(\d+\.\d+\.\d+)/.exec(packageManager) : null;
  if (!match) throw new Error(`package.json packageManager must pin pnpm, found ${JSON.stringify(packageManager)}.`);
  return match[1];
}

// Undefined leaves self-update on plain `pnpm`, whose spawn error is then
// recorded as the failed step instead of killing the job before it reports.
export function resolvePnpm(packageRoot = flyto2RuntimePackageRoot()): string[] | undefined {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { packageManager?: unknown };
  return pnpmInvocation({
    platform: platform(),
    has: commandExists,
    version: pinnedPnpmVersion(packageJson.packageManager),
  });
}
