import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { ConversationContinuityManager } from "./conversation-continuity.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

function chatMeta(id: string) {
  return { _meta: { "openai/session": id } };
}

test("conversation checkpoints preserve continuity without stopping the active chat", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "conversation-continuity-"));
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    storage: { stateDir: join(root, ".state") },
  }));
  const workspaceStore = new SqliteWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const workspace = (await workspaces.openWorkspace(root)).workspace;
  let continuity = new ConversationContinuityManager(config, workspaces);

  t.after(async () => {
    continuity.close();
    workspaceStore.close();
    await rm(root, { recursive: true, force: true });
  });

  const current = chatMeta("chat-continuity-a");
  const first = await continuity.runTool(
    "open_workspace",
    {
      path: root,
      task_context: "Finish the release closure without touching the dirty source checkout.",
    },
    current,
    async () => ({
      content: [{ type: "text", text: "opened" }],
      structuredContent: { workspace_id: workspace.id },
    }),
  );
  assert.equal(first.content[0]?.text, "opened");

  for (let index = 0; index < 7; index += 1) {
    const result = await continuity.runTool(
      index === 6 ? "exec_command" : "read",
      index === 6
        ? { workspace_id: workspace.id, cmd: "echo NEVER_STORE_THIS_COMMAND" }
        : { workspace_id: workspace.id, path: `file-${index}.txt` },
      current,
      async () => ({ content: [{ type: "text", text: `ok-${index}` }] }),
    );
    assert.equal(result.content[0]?.text, `ok-${index}`);
  }

  assert.equal(
    continuity.latestForWorkspace(root, current._meta),
    undefined,
    "a conversation should not feed its own checkpoint back into itself",
  );

  const summary = continuity.latestForWorkspace(root, chatMeta("chat-continuity-b")._meta);
  assert.ok(summary);
  assert.match(summary.checkpoint_id, /^checkpoint_[a-f0-9]{16}$/);
  assert.equal(
    summary.task_context,
    "Finish the release closure without touching the dirty source checkout.",
  );
  assert.equal(summary.recent_activities.some((entry) => entry.includes("NEVER_STORE_THIS_COMMAND")), false);

  const checkpoint = await readFile(
    join(config.stateDir, "handoffs", `${summary.checkpoint_id}.md`),
    "utf8",
  );
  assert.doesNotMatch(checkpoint, /NEVER_STORE_THIS_COMMAND/);
  assert.match(checkpoint, /exec_command: process activity/);

  const afterCheckpoint = await continuity.runTool(
    "read",
    { workspace_id: workspace.id, path: "still-working.txt" },
    current,
    async () => ({ content: [{ type: "text", text: "conversation-kept-running" }] }),
  );
  assert.equal(afterCheckpoint.content[0]?.text, "conversation-kept-running");

  continuity.close();
  continuity = new ConversationContinuityManager(config, workspaces);
  const persisted = continuity.latestForWorkspace(root, chatMeta("chat-continuity-c")._meta);
  assert.equal(persisted?.checkpoint_id, summary.checkpoint_id);
});
