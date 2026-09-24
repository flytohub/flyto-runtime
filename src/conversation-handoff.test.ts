import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { ConversationHandoffManager } from "./conversation-handoff.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

test("a stopped conversation remains stopped after Runtime restarts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "conversation-handoff-persistence-"));
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    storage: { stateDir: join(root, ".state") },
    handoff: {
      enabled: true,
      maxToolCalls: 10,
      maxContextBytes: 10 * 1024 * 1024,
      maxAgeMinutes: 240,
    },
  }));
  const workspaceStore = new SqliteWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const workspace = (await workspaces.openWorkspace(root)).workspace;
  const meta = { _meta: { "openai/session": "persistent-chat-session" } };
  let manager = new ConversationHandoffManager(config, workspaces);

  t.after(async () => {
    manager.close();
    workspaceStore.close();
    await rm(root, { recursive: true, force: true });
  });

  await manager.runTool(
    "open_workspace",
    { path: root, task_context: "Persist the handoff guard across restart." },
    meta,
    async () => ({ structuredContent: { workspace_id: workspace.id }, content: [] }),
  );
  let thresholdResult: unknown;
  for (let index = 0; index < 9; index += 1) {
    thresholdResult = await manager.runTool(
      "read",
      { workspace_id: workspace.id, path: "README.md" },
      meta,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
  }
  assert.match(JSON.stringify(thresholdResult), /handoff_[a-f0-9]{16}/);
  manager.close();

  manager = new ConversationHandoffManager(config, workspaces);
  let executed = false;
  const blocked = await manager.runTool(
    "exec_command",
    { workspace_id: workspace.id, cmd: "echo must-not-run" },
    meta,
    async () => {
      executed = true;
      return { content: [] };
    },
  );
  assert.equal(executed, false);
  assert.match(JSON.stringify(blocked), /stopped further tool execution/i);
});

test("large transferred context creates a handoff before the tool-call budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "conversation-handoff-size-"));
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    storage: { stateDir: join(root, ".state") },
    handoff: {
      enabled: true,
      maxToolCalls: 100,
      maxContextBytes: 64 * 1024,
      maxAgeMinutes: 240,
    },
  }));
  const workspaceStore = new SqliteWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const workspace = (await workspaces.openWorkspace(root)).workspace;
  const manager = new ConversationHandoffManager(config, workspaces);
  const meta = { _meta: { "openai/session": "large-context-chat-session" } };

  t.after(async () => {
    manager.close();
    workspaceStore.close();
    await rm(root, { recursive: true, force: true });
  });

  await manager.runTool(
    "open_workspace",
    { path: root, task_context: "Stop when transferred context becomes too large." },
    meta,
    async () => ({ structuredContent: { workspace_id: workspace.id }, content: [] }),
  );
  const result = await manager.runTool(
    "read",
    { workspace_id: workspace.id, path: "large.log" },
    meta,
    async () => ({ content: [{ type: "text", text: "x".repeat(70 * 1024) }] }),
  );

  const serialized = JSON.stringify(result);
  const id = serialized.match(/handoff_[a-f0-9]{16}/)?.[0];
  assert.ok(id);
  assert.match(manager.getHandoff(id)?.markdown ?? "", /Runtime context transfer reached/);
});
