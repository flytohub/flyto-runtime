import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { flyto2NativeRuntimeHome } from "./native-paths.js";
import {
  QUICK_TUNNEL_METRICS_PORT,
  fetchQuickTunnelHostname,
  locateCloudflared,
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

export function findCloudflared(): string | undefined {
  return locateCloudflared(platform(), () => findCloudflaredBinary());
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
