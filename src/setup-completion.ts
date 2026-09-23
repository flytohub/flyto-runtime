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
  service: ServiceState;
  serviceExitStatus?: number;
}

// launchd "loaded" means registered, not that a process is up: a job whose
// process exits (for example because another program holds its port) stays
// loaded. Only a running state or a live PID counts as running.
export type ServiceState = "running" | "stopped" | "installed" | "not_installed" | "unsupported";

export interface NativeServiceSnapshot {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  state?: string;
  pid?: number;
  lastExitStatus?: number;
}

export function nativeServiceState(service: NativeServiceSnapshot | undefined): ServiceState {
  if (!service || !service.supported) return "unsupported";
  if (service.state === "running" || service.pid !== undefined) return "running";
  if (service.loaded) return "stopped";
  return service.installed ? "installed" : "not_installed";
}

export function describeServiceState(state: ServiceState, lastExitStatus?: number): string {
  switch (state) {
    case "running":
      return "Running";
    case "stopped":
      return `Loaded but not running${lastExitStatus ? ` (last exit status ${lastExitStatus})` : ""}`;
    case "installed":
      return "Installed, not loaded";
    case "not_installed":
      return "Not installed";
    case "unsupported":
      return "Not supported on this platform";
  }
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
  serviceStatus?: () => NativeServiceSnapshot;
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
    service: nativeServiceState(service),
    ...(service?.lastExitStatus ? { serviceExitStatus: service.lastExitStatus } : {}),
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

// A freshly started service needs a moment to bind; poll instead of reporting
// the first failed probe as a failure.
export async function waitForRuntimeHealth(
  probe: () => Promise<SetupRuntimeStatus>,
  { attempts = 10, intervalMs = 1000, sleep = defaultSleep }: {
    attempts?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<SetupRuntimeStatus> {
  let status = await probe();
  for (let attempt = 1; attempt < attempts && status.local !== "ok"; attempt += 1) {
    await sleep(intervalMs);
    status = await probe();
  }
  return status;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    lines.push(`${mark(status.service === "running")} Background service: ${describeServiceState(status.service, status.serviceExitStatus)}`);
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
