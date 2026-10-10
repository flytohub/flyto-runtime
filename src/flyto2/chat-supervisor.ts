import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { flyto2NativeRuntimeHome } from "./native-paths.js";

export const CHAT_SUPERVISOR_LABEL = "com.flyto2.chat-supervisor";

export interface ChatSupervisorPaths {
  root: string;
  appRoot: string;
  executable: string;
  enabledFile: string;
  statusFile: string;
  plistFile: string;
}

export interface ChatSupervisorObservation {
  state: string;
  permissionGranted: boolean;
  observedAt: string;
  appRunning: boolean;
  windowCount: number;
  conversationTitle?: string | null;
  errorHint?: string | null;
  unchangedSeconds?: number | null;
  coverage: string;
}

export function chatSupervisorPaths(home = homedir()): ChatSupervisorPaths {
  const root = join(flyto2NativeRuntimeHome(home), "chat-supervisor");
  const appRoot = join(root, "Flyto2 Chat Supervisor.app");
  return {
    root,
    appRoot,
    executable: join(appRoot, "Contents", "MacOS", "Flyto2ChatSupervisor"),
    enabledFile: join(root, "settings.json"),
    statusFile: join(root, "status.json"),
    plistFile: join(home, "Library", "LaunchAgents", `${CHAT_SUPERVISOR_LABEL}.plist`),
  };
}

export function supervisorEnabled(paths: ChatSupervisorPaths): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.enabledFile, "utf8"));
    return typeof parsed === "object" && parsed !== null && "enabled" in parsed
      && parsed.enabled === true;
  } catch {
    return false;
  }
}

export function readSupervisorObservation(paths: ChatSupervisorPaths): ChatSupervisorObservation | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.statusFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || !("state" in parsed)
      || typeof parsed.state !== "string" || !("observedAt" in parsed)
      || typeof parsed.observedAt !== "string") return null;
    return parsed as ChatSupervisorObservation;
  } catch {
    return null;
  }
}

export function supervisorState(
  enabled: boolean,
  loaded: boolean,
  observation: ChatSupervisorObservation | null,
  now = Date.now(),
): string {
  if (!enabled) return "off";
  if (!loaded) return "not_running";
  if (!observation || !Number.isFinite(Date.parse(observation.observedAt))
    || now - Date.parse(observation.observedAt) > 60_000
    || Date.parse(observation.observedAt) > now + 10_000) return "unresponsive";
  return observation.state;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderChatSupervisorLaunchAgent(paths: ChatSupervisorPaths): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${CHAT_SUPERVISOR_LABEL}</string>`,
    '<key>ProgramArguments</key><array>',
    `<string>${xmlEscape(paths.executable)}</string><string>--watch</string>`,
    `<string>${xmlEscape(paths.statusFile)}</string>`,
    '</array>',
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><true/>',
    '<key>ThrottleInterval</key><integer>10</integer>',
    `<key>StandardOutPath</key><string>${xmlEscape(join(paths.root, "stdout.log"))}</string>`,
    `<key>StandardErrorPath</key><string>${xmlEscape(join(paths.root, "stderr.log"))}</string>`,
    '</dict></plist>',
  ].join("\n");
}

function writeAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, path);
}

function macOnly(): void {
  if (platform() !== "darwin") {
    throw new Error("Flyto2 Chat Supervisor currently supports macOS only.");
  }
}

function launchctl(action: string, ...rest: string[]): void {
  execFileSync("launchctl", [action, ...rest], { encoding: "utf8", stdio: "pipe", timeout: 15_000 });
}

function launchDomain(): string {
  return `gui/${userInfo().uid}`;
}

function agentLoaded(): boolean {
  return spawnSync("launchctl", ["print", `${launchDomain()}/${CHAT_SUPERVISOR_LABEL}`], {
    stdio: "ignore", timeout: 3000,
  }).status === 0;
}

function installObserver(paths: ChatSupervisorPaths): void {
  const swiftPath = fileURLToPath(new URL("../../scripts/macos/chat-supervisor.swift", import.meta.url));
  if (!existsSync(swiftPath)) throw new Error("Flyto2 Chat Supervisor Swift source is missing from this distribution.");
  const sourceHash = createHash("sha256").update(readFileSync(swiftPath)).digest("hex");
  const digestPath = join(paths.root, "installed-source.sha256");
  // Don't needlessly rebuild a signed app: a different code signature may
  // invalidate the explicit Accessibility consent already granted by the user.
  if (existsSync(paths.executable) && existsSync(digestPath)
    && readFileSync(digestPath, "utf8").trim() === sourceHash) return;
  mkdirSync(dirname(paths.executable), { recursive: true, mode: 0o700 });
  execFileSync("xcrun", ["swiftc", "-O", swiftPath, "-o", paths.executable], {
    encoding: "utf8", stdio: "pipe", timeout: 120_000,
  });
  writeAtomic(join(paths.appRoot, "Contents", "Info.plist"), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleIdentifier</key><string>com.flyto2.chat-supervisor</string>',
    '<key>CFBundleExecutable</key><string>Flyto2ChatSupervisor</string>',
    '<key>CFBundleName</key><string>Flyto2 Chat Supervisor</string>',
    '<key>CFBundlePackageType</key><string>APPL</string>',
    '<key>LSUIElement</key><true/>',
    '</dict></plist>',
  ].join("\n"));
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", paths.appRoot], {
    encoding: "utf8", stdio: "pipe", timeout: 20_000,
  });
  writeAtomic(digestPath, sourceHash);
}

export function chatSupervisorStatus(paths = chatSupervisorPaths()): object {
  const enabled = supervisorEnabled(paths);
  const loaded = platform() === "darwin" && agentLoaded();
  const observation = readSupervisorObservation(paths);
  return {
    supported: platform() === "darwin",
    enabled,
    state: supervisorState(enabled, loaded, observation),
    loaded,
    permission_granted: observation?.permissionGranted ?? false,
    observation,
    capabilities: {
      visible_chat_observation: true,
      error_detection: true,
      automatic_ui_recovery: false,
      automatic_handoff: false,
      automatic_chat_creation: false,
      automatic_delete: false,
    },
    next: enabled && observation?.permissionGranted !== true
      ? "Allow Flyto2 Chat Supervisor in macOS System Settings > Privacy & Security > Accessibility."
      : undefined,
  };
}

export function setChatSupervisorEnabled(enabled: boolean, paths = chatSupervisorPaths()): object {
  macOnly();
  const wasLoaded = agentLoaded();
  if (!enabled) {
    writeAtomic(paths.enabledFile, JSON.stringify({ enabled: false }, null, 2));
    if (wasLoaded) launchctl("bootout", `${launchDomain()}/${CHAT_SUPERVISOR_LABEL}`);
    return chatSupervisorStatus(paths);
  }
  // Build the signed observer before opting in. Never switch an existing
  // running observer to a partial or unsigned build.
  installObserver(paths);
  const plist = renderChatSupervisorLaunchAgent(paths);
  writeAtomic(paths.plistFile, plist);
  if (wasLoaded) launchctl("bootout", `${launchDomain()}/${CHAT_SUPERVISOR_LABEL}`);
  launchctl("bootstrap", launchDomain(), paths.plistFile);
  writeAtomic(paths.enabledFile, JSON.stringify({ enabled: true }, null, 2));
  // The user must grant this separately. Opening Settings is not permission.
  spawnSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], {
    stdio: "ignore", timeout: 5000,
  });
  return chatSupervisorStatus(paths);
}

export function runChatSupervisorCommand(args: string[]): void {
  const [action = "status", ...rest] = args;
  if (rest.length || !["on", "off", "status"].includes(action)) {
    throw new Error("Usage: flyto2-runtime supervisor <on|off|status>");
  }
  const result = action === "status"
    ? chatSupervisorStatus()
    : setChatSupervisorEnabled(action === "on");
  console.log(JSON.stringify(result, null, 2));
}
