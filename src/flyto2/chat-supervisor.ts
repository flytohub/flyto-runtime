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
  windowSource?: "accessibility" | "window_server_only" | null;
  accessibilityErrorCode?: number | null;
  stopControlVisible?: boolean | null;
}

export type ChatRecoveryCategory =
  | "conversation_handoff"
  | "possible_conversation_limit"
  | "connection_recovery"
  | "message_delivery_recovery"
  | "ui_progress_review"
  | "error_review"
  | "none";

export interface ChatRecoveryRecommendation {
  category: ChatRecoveryCategory;
  priority: "urgent" | "review" | "none";
  recommendation: string;
  automaticActionEnabled: false;
}

/** Read-only diagnosis. A ChatGPT window is not proof that a task is stopped. */
export function chatRecoveryRecommendation(state: string): ChatRecoveryRecommendation {
  const choices: Record<string, ChatRecoveryRecommendation> = {
    conversation_limit_reached: {
      category: "conversation_handoff",
      priority: "urgent",
      recommendation: "Save the available conversation and verify local task evidence, then hand off to a correctly named new chat. Do not press Continue in the capped chat or delete the old one.",
      automaticActionEnabled: false,
    },
    conversation_limit_needs_review: {
      category: "possible_conversation_limit",
      priority: "review",
      recommendation: "Confirm that the actual ChatGPT limit banner and Start New Chat control are present; quoted chat text is not enough evidence.",
      automaticActionEnabled: false,
    },
    connection_interrupted: {
      category: "connection_recovery",
      priority: "review",
      recommendation: "Check Runtime commands and side-effect evidence, then stop the stalled response and send a guarded Continue only if safe.",
      automaticActionEnabled: false,
    },
    message_send_timeout: {
      category: "message_delivery_recovery",
      priority: "review",
      recommendation: "ChatGPT reports a message send timeout and shows Retry. Check whether the preceding request or command took effect before any bounded resend. Do not blindly click Retry or duplicate a side-effecting operation.",
      automaticActionEnabled: false,
    },
    message_timeout_needs_review: {
      category: "message_delivery_recovery",
      priority: "review",
      recommendation: "Possible send timeout text without a verified Retry control. Inspect the active conversation before taking action.",
      automaticActionEnabled: false,
    },
    unchanged_needs_review: {
      category: "ui_progress_review",
      priority: "review",
      recommendation: "Confirm ChatGPT is generating and local tools are idle before diagnosing a stall; unchanged text alone does not justify stopping.",
      automaticActionEnabled: false,
    },
    error_detected: {
      category: "error_review",
      priority: "review",
      recommendation: "Inspect the specific error and local task evidence before retrying or refreshing.",
      automaticActionEnabled: false,
    },
  };
  return choices[state] ?? {
    category: "none",
    priority: "none",
    recommendation: "No recovery action is indicated by the current observable evidence.",
    automaticActionEnabled: false,
  };
}

export function chatSupervisorPaths(
  home = homedir(),
  applicationDirectory = platform() === "darwin" && home === homedir()
    ? "/Applications"
    : join(home, "Applications"),
): ChatSupervisorPaths {
  const root = join(flyto2NativeRuntimeHome(home), "chat-supervisor");
  // macOS permission pickers should discover a normal Applications bundle,
  // not an app hidden inside Application Support state files.
  const appRoot = join(applicationDirectory, "Flyto2 Chat Supervisor.app");
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

function startSupervisorAgent(paths: ChatSupervisorPaths): void {
  // launchd can race its own teardown after bootout. A failed first bootstrap
  // should not turn a requested ON state into a stranded, unloaded service.
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (!agentLoaded()) launchctl("bootstrap", launchDomain(), paths.plistFile);
      if (agentLoaded()) return;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) {
      execFileSync("/bin/sleep", ["1"], { timeout: 2500, stdio: "ignore" });
    }
  }
  throw new Error(`Chat Supervisor LaunchAgent did not start: ${String(lastError)}`);
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

function registerMacApp(appRoot: string): void {
  // A background app started from a LaunchAgent may not be listed by macOS
  // permission pickers until it is registered with LaunchServices.
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  if (existsSync(lsregister)) {
    execFileSync(lsregister, ["-f", appRoot], { stdio: "pipe", timeout: 15_000 });
  }
}

export function chatSupervisorStatus(paths = chatSupervisorPaths()): object {
  const enabled = supervisorEnabled(paths);
  const loaded = platform() === "darwin" && agentLoaded();
  const observation = readSupervisorObservation(paths);
  const state = supervisorState(enabled, loaded, observation);
  return {
    supported: platform() === "darwin",
    enabled,
    state,
    loaded,
    permission_granted: observation?.permissionGranted ?? false,
    observation,
    recovery: chatRecoveryRecommendation(state),
    capabilities: {
      visible_window_detection: true,
      accessible_chat_observation: enabled && loaded && observation?.windowSource === "accessibility",
      error_detection: enabled && loaded && observation?.windowSource === "accessibility",
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
  const previousSourceHash = existsSync(join(paths.root, "installed-source.sha256"))
    ? readFileSync(join(paths.root, "installed-source.sha256"), "utf8") : null;
  const previousPlist = existsSync(paths.plistFile)
    ? readFileSync(paths.plistFile, "utf8") : null;
  installObserver(paths);
  registerMacApp(paths.appRoot);
  const plist = renderChatSupervisorLaunchAgent(paths);
  const sourceUnchanged = previousSourceHash !== null
    && previousSourceHash === readFileSync(join(paths.root, "installed-source.sha256"), "utf8");
  // No-op ON must not restart a healthy app: unnecessary service churn can
  // invalidate its Accessibility approval on an ad-hoc signed dev build.
  if (wasLoaded && previousPlist === plist && sourceUnchanged) {
    writeAtomic(paths.enabledFile, JSON.stringify({ enabled: true }, null, 2));
    return chatSupervisorStatus(paths);
  }
  writeAtomic(paths.plistFile, plist);
  if (wasLoaded) {
    launchctl("bootout", `${launchDomain()}/${CHAT_SUPERVISOR_LABEL}`);
    // launchctl can briefly report the outgoing old service as still loaded.
    // Wait for complete teardown before attempting to bootstrap its replacement.
    for (let attempt = 0; attempt < 8 && agentLoaded(); attempt += 1) {
      execFileSync("/bin/sleep", ["1"], { timeout: 2500, stdio: "ignore" });
    }
    if (agentLoaded()) throw new Error("Previous Chat Supervisor has not finished stopping.");
  }
  startSupervisorAgent(paths);
  writeAtomic(paths.enabledFile, JSON.stringify({ enabled: true }, null, 2));
  // The user must grant this separately. Opening Settings is not permission.
  spawnSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], {
    stdio: "ignore", timeout: 5000,
  });
  spawnSync("open", ["-R", paths.appRoot], { stdio: "ignore", timeout: 5000 });
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
