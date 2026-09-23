import { spawn } from "node:child_process";

// Setup is finished when the user can connect, not when config is saved. This
// module gathers the facts the Setup complete screen reports and formats them;
// the interactive loop lives in cli.ts so it can share the launcher's prompts.

// "foreign" means something answered /healthz but it is not this Runtime, for
// example the legacy DevSpace kit still holding the configured port.
export type ProbeState = "ok" | "foreign" | "unreachable" | "not_configured";

export interface SetupRuntimeStatus {
  local: ProbeState;
  publicEndpoint: ProbeState;
  // launchd/Task Scheduler "loaded" means registered, not that the process is up;
  // the local health probe is what proves the Runtime is serving.
  service: "loaded" | "installed" | "not_installed" | "unsupported";
}

export interface SetupConnectionDetails {
  mcpUrl: string;
  ownerPassword: string;
  pluginPath?: string;
}

export interface SetupStatusProbes {
  localBaseUrl: string;
  publicBaseUrl: string | null;
  fetchHealth?: (url: string) => Promise<ProbeState>;
  serviceStatus?: () => { supported: boolean; installed: boolean; loaded: boolean };
}

export async function collectSetupStatus(probes: SetupStatusProbes): Promise<SetupRuntimeStatus> {
  const fetchHealth = probes.fetchHealth ?? probeRuntimeHealth;
  const [local, publicEndpoint] = await Promise.all([
    fetchHealth(`${probes.localBaseUrl}/healthz`),
    probes.publicBaseUrl ? fetchHealth(`${probes.publicBaseUrl}/healthz`) : Promise.resolve(undefined),
  ]);
  const service = probes.serviceStatus?.();
  return {
    local,
    publicEndpoint: publicEndpoint ?? "not_configured",
    service: !service || !service.supported
      ? "unsupported"
      : service.loaded ? "loaded" : service.installed ? "installed" : "not_installed",
  };
}

export async function probeRuntimeHealth(url: string): Promise<ProbeState> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return "unreachable";
    const health = await response.json() as { ok?: unknown; name?: unknown };
    return health.ok === true && health.name === "flyto2-runtime" ? "ok" : "foreign";
  } catch {
    return "unreachable";
  }
}

export function setupIsConnectable(status: SetupRuntimeStatus): boolean {
  return status.local === "ok" && (status.publicEndpoint === "ok" || status.publicEndpoint === "not_configured");
}

export function formatSetupStatus(status: SetupRuntimeStatus): string[] {
  const mark = (ok: boolean) => (ok ? "[ok]" : "[!!]");
  const local = {
    ok: "Running (health check passed)",
    foreign: "Port is held by another program, not this Runtime (a legacy DevSpace kit?)",
    unreachable: "Not running (health check failed)",
    not_configured: "Not configured",
  }[status.local];
  const lines = [`${mark(status.local === "ok")} Runtime:            ${local}`];
  if (status.publicEndpoint !== "not_configured") {
    const endpoint = {
      ok: "Reachable",
      foreign: "Reaches a different server, not this Runtime",
      unreachable: "Unreachable (check the tunnel or reverse proxy)",
    }[status.publicEndpoint];
    lines.push(`${mark(status.publicEndpoint === "ok")} Public endpoint:    ${endpoint}`);
  }
  if (status.service !== "unsupported") {
    const label = { loaded: "Loaded", installed: "Installed, not loaded", not_installed: "Not installed" }[status.service];
    lines.push(`${mark(status.service === "loaded")} Background service: ${label}`);
  }
  return lines;
}

export function formatConnectionDetails(
  details: SetupConnectionDetails,
  { revealPassword }: { revealPassword: boolean },
): string[] {
  return [
    `MCP URL:        ${details.mcpUrl}`,
    `Owner password: ${revealPassword ? details.ownerPassword : maskSecret(details.ownerPassword)}`,
    ...(details.pluginPath ? [`ChatGPT plugin: ${details.pluginPath}`] : []),
  ];
}

// The clipboard copy is the one place the full password leaves the screen.
export function connectionDetailsClipboardText(details: SetupConnectionDetails): string {
  return formatConnectionDetails(details, { revealPassword: true }).join("\n");
}

export function maskSecret(secret: string): string {
  if (secret.length <= 4) return "*".repeat(secret.length);
  return `${"*".repeat(Math.min(secret.length - 4, 16))}${secret.slice(-4)}`;
}

export interface ClipboardCommand {
  command: string;
  args: string[];
}

export function clipboardCommands(platform: NodeJS.Platform): ClipboardCommand[] {
  switch (platform) {
    case "darwin":
      return [{ command: "pbcopy", args: [] }];
    case "win32":
      return [{ command: "clip.exe", args: [] }];
    default:
      return [
        { command: "wl-copy", args: [] },
        { command: "xclip", args: ["-selection", "clipboard"] },
        { command: "xsel", args: ["--clipboard", "--input"] },
      ];
  }
}

// The text goes to the clipboard tool over stdin, never through argv, so the
// password does not appear in the process list.
export async function copyToClipboard(
  text: string,
  platform: NodeJS.Platform = process.platform,
  run: (command: ClipboardCommand, input: string) => Promise<boolean> = runClipboardCommand,
): Promise<boolean> {
  for (const command of clipboardCommands(platform)) {
    if (await run(command, text)) return true;
  }
  return false;
}

function runClipboardCommand({ command, args }: ClipboardCommand, input: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
    child.stdin.once("error", () => resolve(false));
    child.stdin.end(input);
  });
}
