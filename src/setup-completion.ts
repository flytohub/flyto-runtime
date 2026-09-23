import { execFileSync } from "node:child_process";

export interface SetupNativeServiceStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  state?: string;
}

export interface SetupCompletionDetails {
  mcpUrl: string;
  ownerPassword: string;
  pluginPath?: string;
}

export interface SetupCompletionSnapshot {
  healthOk: boolean;
  service: SetupNativeServiceStatus;
}

export function backgroundServiceSummary(service: SetupNativeServiceStatus): string {
  if (!service.supported) return "not supported";
  if (service.loaded) {
    return service.state && service.state !== "running"
      ? "running (" + service.state + ")"
      : "running";
  }
  if (service.installed) return service.state ? "installed (" + service.state + ")" : "installed";
  return "not installed";
}

export function formatSetupCompletion(
  details: SetupCompletionDetails,
  snapshot: SetupCompletionSnapshot,
): string {
  return [
    "Runtime: " + (snapshot.healthOk ? "Running" : "Stopped"),
    "Health: " + (snapshot.healthOk ? "OK" : "Unreachable"),
    "Background service: " + backgroundServiceSummary(snapshot.service),
    "MCP URL: " + details.mcpUrl,
    "Owner password: " + details.ownerPassword,
    ...(details.pluginPath ? ["ChatGPT plugin ZIP: " + details.pluginPath] : []),
  ].join("\n");
}

export function allConnectionDetails(details: SetupCompletionDetails): string {
  return [
    "MCP URL: " + details.mcpUrl,
    "Owner password: " + details.ownerPassword,
    ...(details.pluginPath ? ["ChatGPT plugin ZIP: " + details.pluginPath] : []),
  ].join("\n");
}

export function copyToClipboard(value: string, targetPlatform = process.platform): void {
  if (targetPlatform === "darwin") {
    execFileSync("pbcopy", [], { input: value });
    return;
  }
  if (targetPlatform === "win32") {
    execFileSync("clip.exe", [], { input: value, windowsHide: true });
    return;
  }
  throw new Error("Clipboard copy is currently supported on macOS and Windows.");
}
