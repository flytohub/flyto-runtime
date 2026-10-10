import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHAT_SUPERVISOR_LABEL,
  chatSupervisorPaths,
  readSupervisorObservation,
  renderChatSupervisorLaunchAgent,
  supervisorEnabled,
  supervisorState,
} from "./chat-supervisor.js";

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

test("launchd supervisor only launches the dedicated observer, never the runtime server", () => {
  const plist = renderChatSupervisorLaunchAgent(chatSupervisorPaths("/Users/Chester & Team's"));
  assert.match(plist, new RegExp(CHAT_SUPERVISOR_LABEL.replaceAll(".", "\\.")));
  assert.match(plist, /Flyto2ChatSupervisor/);
  assert.match(plist, /--watch/);
  assert.match(plist, /&amp;/);
  assert.match(plist, /&apos;/);
  assert.doesNotMatch(plist, /cli\.js serve/);
});
