import { platform } from "node:os";
export { importCloudflareTunnel } from "./tunnel-import.js";
import {
  installNativeTunnelService as installMacTunnelService,
  loadNativeTunnelProfile as loadMacTunnelProfile,
  migrateLegacyCloudflareTunnel as migrateLegacyMacCloudflareTunnel,
  nativeTunnelReadiness as macTunnelReadiness,
  nativeTunnelStatus as macTunnelStatus,
  startNativeTunnelService as startMacTunnelService,
  stopNativeTunnelService as stopMacTunnelService,
} from "./macos-tunnel.js";
import {
  installWindowsTunnelService,
  loadWindowsTunnelProfile,
  startWindowsTunnelService,
  stopWindowsTunnelService,
  windowsNativeTunnelReadiness,
  windowsNativeTunnelStatus,
} from "./windows-tunnel.js";

export interface NativeTunnelReadiness {
  supported: boolean;
  configured: boolean;
  connector_count: number;
  ready_connectors: number;
  connectors: Array<{ label: string; ready: boolean }>;
}

export function nativeTunnelManagementSupported(): boolean {
  return platform() === "darwin" || platform() === "win32";
}

export function loadNativeTunnelProfile() {
  switch (platform()) {
    case "darwin":
      return loadMacTunnelProfile();
    case "win32":
      return loadWindowsTunnelProfile();
    default:
      return undefined;
  }
}

export function migrateLegacyCloudflareTunnel(configDirectory: string) {
  if (platform() !== "darwin") {
    throw new Error("Legacy Mac Kit tunnel migration is available on macOS only.");
  }
  return migrateLegacyMacCloudflareTunnel(configDirectory);
}

export function installNativeTunnelService(start = true) {
  switch (platform()) {
    case "darwin":
      return installMacTunnelService(undefined, start);
    case "win32":
      return installWindowsTunnelService(start);
    default:
      throw unsupported();
  }
}

export function startNativeTunnelService() {
  switch (platform()) {
    case "darwin":
      return startMacTunnelService();
    case "win32":
      return startWindowsTunnelService();
    default:
      throw unsupported();
  }
}

export function stopNativeTunnelService() {
  switch (platform()) {
    case "darwin":
      return stopMacTunnelService();
    case "win32":
      return stopWindowsTunnelService();
    default:
      throw unsupported();
  }
}

export function nativeTunnelStatus() {
  switch (platform()) {
    case "darwin":
      return macTunnelStatus();
    case "win32":
      return windowsNativeTunnelStatus();
    default:
      return {
        supported: false,
        configured: false,
        loaded: false,
        label: "flyto2-runtime-tunnel",
        connector_count: 0,
        running_connectors: 0,
        redundant: false,
        connectors: [],
      };
  }
}

export async function nativeTunnelReadiness(): Promise<NativeTunnelReadiness> {
  switch (platform()) {
    case "darwin":
      return macTunnelReadiness();
    case "win32":
      return windowsNativeTunnelReadiness();
    default:
      return {
        supported: false,
        configured: false,
        connector_count: 0,
        ready_connectors: 0,
        connectors: [],
      };
  }
}

export function shouldRepairNativeTunnelRedundancy(
  readiness: NativeTunnelReadiness,
): boolean {
  return readiness.supported
    && readiness.configured
    && readiness.connector_count >= 2
    && readiness.ready_connectors < readiness.connector_count;
}

function unsupported(): Error {
  return new Error(
    `Flyto2 Runtime tunnel service management is not supported on ${platform()}.`,
  );
}
