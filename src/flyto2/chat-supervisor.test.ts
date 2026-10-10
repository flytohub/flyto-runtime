import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHAT_SUPERVISOR_LABEL,
  chatRecoveryRecommendation,
  chatSupervisorPaths,
  readSupervisorObservation,
  renderChatSupervisorLaunchAgent,
  supervisorEnabled,
  supervisorState,
} from "./chat-supervisor.js";

test("conversation hard limit requires handoff rather than stop/continue", () => {
  const limit = chatRecoveryRecommendation("conversation_limit_reached");
  assert.equal(limit.category, "conversation_handoff");
  assert.equal(limit.priority, "urgent");
  assert.equal(limit.automaticActionEnabled, false);
  assert.match(limit.recommendation, /new chat/);
  assert.match(limit.recommendation, /Do not press Continue/);
  assert.equal(chatRecoveryRecommendation("conversation_limit_needs_review").category, "possible_conversation_limit");
  assert.equal(chatRecoveryRecommendation("connection_interrupted").category, "connection_recovery");
  assert.equal(chatRecoveryRecommendation("message_send_timeout").category, "message_delivery_recovery");
  assert.equal(chatRecoveryRecommendation("message_send_timeout").automaticActionEnabled, false);
  assert.equal(chatRecoveryRecommendation("unchanged_needs_review").category, "ui_progress_review");
  assert.equal(chatRecoveryRecommendation("permission_required").category, "none");
  assert.equal(chatRecoveryRecommendation("off").category, "none");
});

test("native observer recognizes conversation caps and interruptions", {
  skip: process.platform !== "darwin" ? "requires macOS Swift compiler" : false,
}, (t) => {
  const buildDirectory = mkdtempSync(join(tmpdir(), "flyto2-native-chat-rules-"));
  t.after(() => rmSync(buildDirectory, { recursive: true, force: true }));
  const binary = join(buildDirectory, "Flyto2ChatSupervisor");
  const source = fileURLToPath(new URL("../../scripts/macos/chat-supervisor.swift", import.meta.url));
  execFileSync("xcrun", ["swiftc", "-O", source, "-o", binary], { timeout: 120_000 });
  assert.match(execFileSync(binary, ["--self-test"], {
    encoding: "utf8", timeout: 15_000,
  }), /classification tests passed/);
});

test("Chat Supervisor keeps its app in Applications, outside hidden local state", () => {
  const paths = chatSupervisorPaths("/Users/Test Person", "/Applications");
  assert.equal(paths.appRoot, join("/Applications", "Flyto2 Chat Supervisor.app"));
  assert.equal(paths.executable, join(paths.appRoot, "Contents", "MacOS", "Flyto2ChatSupervisor"));
  assert.equal(basename(paths.statusFile), "status.json");
  assert.equal(basename(dirname(paths.statusFile)), "chat-supervisor");
  assert.notEqual(paths.root, paths.appRoot);
});

test("Chat Supervisor remains disabled unless the user explicitly opts in", (t) => {
  const root = mkdtempSync(join(tmpdir(), "flyto2-chat-supervisor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = chatSupervisorPaths(root);
  assert.equal(supervisorEnabled(paths), false);
  assert.equal(supervisorState(false, true, null), "off");
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.enabledFile, JSON.stringify({ enabled: true }));
  assert.equal(supervisorEnabled(paths), true);
  writeFileSync(paths.enabledFile, "invalid json");
  assert.equal(supervisorEnabled(paths), false);
});

test("Chat Supervisor fail-closes stale status and untrusted UI", (t) => {
  const root = mkdtempSync(join(tmpdir(), "flyto2-chat-supervisor-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = chatSupervisorPaths(root);
  mkdirSync(paths.root, { recursive: true });
  assert.equal(readSupervisorObservation(paths), null);
  const observedAt = "2026-10-10T14:00:00.000Z";
  const observation = {
    state: "permission_required", permissionGranted: false, appRunning: true,
    observedAt, windowCount: 0, coverage: "visible_chatgpt_windows_only",
  };
  writeFileSync(paths.statusFile, JSON.stringify(observation));
  assert.deepEqual(readSupervisorObservation(paths), observation);
  assert.equal(supervisorState(true, true, observation, Date.parse(observedAt) + 15_000), "permission_required");
  assert.equal(supervisorState(true, false, observation), "not_running");
  assert.equal(supervisorState(true, true, observation, Date.parse(observedAt) + 61_000), "unresponsive");
  assert.equal(supervisorState(true, true, null), "unresponsive");
});

test("Chat Supervisor accepts a visible but inaccessible window as an incomplete observation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "flyto2-chat-supervisor-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = chatSupervisorPaths(root);
  mkdirSync(paths.root, { recursive: true });
  const observedAt = new Date().toISOString();
  const status = {
    state: "window_detected_unreadable", permissionGranted: true,
    appRunning: true, observedAt, windowCount: 1,
    coverage: "visible_chatgpt_windows_only", windowSource: "window_server_only" as const,
    accessibilityErrorCode: -25205,
  };
  writeFileSync(paths.statusFile, JSON.stringify(status));
  assert.deepEqual(readSupervisorObservation(paths), status);
  assert.equal(supervisorState(true, true, status), "window_detected_unreadable");
});

test("launchd supervisor only launches the dedicated observer, never the runtime server", () => {
  const plist = renderChatSupervisorLaunchAgent(chatSupervisorPaths("/Users/Chester & Team's"));
  assert.match(plist, new RegExp(CHAT_SUPERVISOR_LABEL.replaceAll(".", "\\.")));
  assert.match(plist, /Flyto2ChatSupervisor/);
  assert.match(plist, /--watch/);
  assert.match(plist, /&amp;/);
  assert.match(plist, /&apos;/);
  assert.doesNotMatch(plist, /cli\.js serve/);
});
