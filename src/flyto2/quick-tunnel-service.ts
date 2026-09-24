import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { bundledCloudflaredPath } from "./distribution.js";
import { flyto2NativeRuntimeHome } from "./native-paths.js";
import {
  CLOUDFLARED_RELEASES,
  CLOUDFLARE_APPLE_TEAM_ID,
  QUICK_TUNNEL_METRICS_PORT,
  cloudflaredReleaseAsset,
  downloadedCloudflaredCandidates,
  fetchQuickTunnelHostname,
  locateCloudflared,
  managedCloudflaredPath,
  quickTunnelArguments,
  quickTunnelProfilePath,
  readQuickTunnelProfile,
  waitForPublicDns,
  waitForQuickTunnelHostname,
  writeQuickTunnelProfile,
  type QuickTunnelProfile,
} from "./quick-tunnel.js";
import { findCloudflaredBinary } from "./tunnel-import.js";

export const QUICK_TUNNEL_LAUNCH_AGENT_LABEL = "local.flyto2.runtime.quicktunnel";
export const QUICK_TUNNEL_WINDOWS_TASK = "Flyto2 Runtime Quick Tunnel";

export interface QuickTunnelStatus {
  configured: boolean;
  running: boolean;
  hostname?: string;
  public_base_url?: string;
}

export function findCloudflared(runtimeHome = flyto2NativeRuntimeHome()): string | undefined {
  // The packaged app ships a signed cloudflared of its own.
  const bundled = bundledCloudflaredPath();
  if (existsSync(bundled)) return bundled;
  return locateCloudflared(platform(), () => findCloudflaredBinary(), { runtimeHome, home: homedir(), env: process.env });
}

export type CloudflaredSource =
  | { kind: "installed"; path: string }
  | { kind: "downloaded"; path: string }
  | { kind: "release"; url: string }
  | { kind: "unsupported" };

// Where setup would get cloudflared from, so it can tell the user before
// fetching anything.
export function cloudflaredSource(runtimeHome = flyto2NativeRuntimeHome()): CloudflaredSource {
  const installed = findCloudflared(runtimeHome);
  if (installed) return { kind: "installed", path: installed };
  const downloaded = downloadedCloudflaredCandidates(platform(), homedir()).find((path) => existsSync(path));
  if (downloaded) return { kind: "downloaded", path: downloaded };
  const asset = cloudflaredReleaseAsset(platform(), arch());
  return asset ? { kind: "release", url: `${CLOUDFLARED_RELEASES}/${asset}` } : { kind: "unsupported" };
}

// Puts a Cloudflare-signed cloudflared in Runtime's bin and returns its path.
// Nothing needs an administrator: the file lives under the user's own home.
export async function provideCloudflared(
  source: Exclude<CloudflaredSource, { kind: "installed" | "unsupported" }>,
  { runtimeHome = flyto2NativeRuntimeHome(), fetchImpl = fetch }: { runtimeHome?: string; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "flyto2-cloudflared-"));
  try {
    let file = source.kind === "downloaded" ? source.path : join(work, basename(new URL(source.url).pathname));
    if (source.kind === "release") {
      const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`Downloading ${source.url} failed with HTTP ${response.status}.`);
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    if (file.endsWith(".tgz")) {
      const extracted = spawnSync("tar", ["-xzf", file, "-C", work], { encoding: "utf8", windowsHide: true });
      file = join(work, "cloudflared");
      if (extracted.status !== 0 || !existsSync(file)) {
        throw new Error(`Could not extract cloudflared: ${(extracted.stderr || "").trim() || "no cloudflared in the archive"}.`);
      }
    }
    verifyCloudflareSignature(file);

    const target = managedCloudflaredPath(runtimeHome, platform());
    mkdirSync(dirname(target), { recursive: true });
    const staged = `${target}.new`;
    copyFileSync(file, staged);
    if (platform() !== "win32") {
      chmodSync(staged, 0o755);
      // A browser download carries quarantine; the signature was checked above.
      spawnSync("xattr", ["-d", "com.apple.quarantine", staged], { stdio: "ignore" });
    }
    renameSync(staged, target);
    return target;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function verifyCloudflareSignature(file: string): void {
  const result = platform() === "win32"
    ? spawnSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$s = Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}'; `
          + "if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'Cloudflare, Inc\\.') { exit 0 } else { exit 1 }",
      ], { encoding: "utf8", windowsHide: true })
    : spawnSync("codesign", [
        "--verify",
        "--strict",
        `-R=anchor apple generic and certificate leaf[subject.OU] = "${CLOUDFLARE_APPLE_TEAM_ID}"`,
        file,
      ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${file} is not signed by Cloudflare, so Runtime will not run it.`);
  }
}

export function commandExists(command: string): boolean {
  const lookup = platform() === "win32" ? "where.exe" : "which";
  return spawnSync(lookup, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

export async function startQuickTunnel(options: {
  binaryPath: string;
  originPort: number;
  runtimeHome?: string;
}): Promise<QuickTunnelStatus> {
  const runtimeHome = options.runtimeHome ?? flyto2NativeRuntimeHome();
  const profile: QuickTunnelProfile = {
    binary_path: options.binaryPath,
    metrics_port: QUICK_TUNNEL_METRICS_PORT,
    origin_port: options.originPort,
  };
  writeQuickTunnelProfile(runtimeHome, profile);
  const logPath = join(dirname(quickTunnelProfilePath(runtimeHome)), "quick-tunnel.log");

  switch (platform()) {
    case "darwin": {
      const { startMacOneShotAgent } = await import("./macos-service.js");
      startMacOneShotAgent({
        label: QUICK_TUNNEL_LAUNCH_AGENT_LABEL,
        plistPath: macQuickTunnelPlistPath(),
        programArguments: [profile.binary_path, ...quickTunnelArguments(profile)],
        environment: {},
        logPath,
        keepAlive: true,
      });
      break;
    }
    case "win32": {
      const { startWindowsOneShotTask } = await import("./windows-service.js");
      startWindowsOneShotTask({
        taskName: QUICK_TUNNEL_WINDOWS_TASK,
        xmlPath: win32.join(dirname(quickTunnelProfilePath(runtimeHome)), "quick-tunnel-task.xml"),
        command: profile.binary_path,
        arguments: quickTunnelArguments(profile),
        workingDirectory: dirname(quickTunnelProfilePath(runtimeHome)),
        persistent: true,
      });
      break;
    }
    default:
      throw new Error(
        `Automatic quick tunnels need the macOS or Windows service manager. Run \`cloudflared ${quickTunnelArguments(profile).join(" ")}\` yourself and paste its URL.`,
      );
  }

  const hostname = await waitForQuickTunnelHostname(profile.metrics_port);
  if (!hostname) {
    throw new Error(`cloudflared started but did not report a public URL within 45 seconds. See ${logPath}.`);
  }
  await waitForPublicDns(hostname);
  return { configured: true, running: true, hostname, public_base_url: `https://${hostname}` };
}

export async function stopQuickTunnel(runtimeHome = flyto2NativeRuntimeHome()): Promise<QuickTunnelStatus> {
  switch (platform()) {
    case "darwin": {
      const { stopMacAgent } = await import("./macos-service.js");
      stopMacAgent(QUICK_TUNNEL_LAUNCH_AGENT_LABEL, macQuickTunnelPlistPath());
      break;
    }
    case "win32": {
      const { stopWindowsTask } = await import("./windows-service.js");
      stopWindowsTask(QUICK_TUNNEL_WINDOWS_TASK);
      break;
    }
  }
  rmSync(quickTunnelProfilePath(runtimeHome), { force: true });
  return { configured: false, running: false };
}

export async function quickTunnelStatus(runtimeHome = flyto2NativeRuntimeHome()): Promise<QuickTunnelStatus> {
  const profile = readQuickTunnelProfile(runtimeHome);
  if (!profile) return { configured: false, running: false };
  const hostname = await fetchQuickTunnelHostname(profile.metrics_port);
  return {
    configured: true,
    running: hostname !== undefined,
    ...(hostname ? { hostname, public_base_url: `https://${hostname}` } : {}),
  };
}

function macQuickTunnelPlistPath(): string {
  return posix.join(homedir(), "Library", "LaunchAgents", `${QUICK_TUNNEL_LAUNCH_AGENT_LABEL}.plist`);
}
