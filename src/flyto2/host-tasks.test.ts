import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostTaskStore } from "./host-tasks.js";

test("HostTaskStore persists ChatGPT-owned task state", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-host-task-"));
  const store = new HostTaskStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const created = store.create({
    workspaceId: "ws_1",
    workspaceRoot: "/workspace",
    prompt: "Fix the issue.",
  });
  assert.match(created.id, /^task_[a-f0-9]{32}$/);
  assert.equal(created.status, "active");
  assert.equal(created.prompt, "Fix the issue.");

  const checkpointed = store.checkpoint(created.id, "Edited source; tests pending.");
  assert.equal(checkpointed?.checkpoint, "Edited source; tests pending.");
  assert.equal(checkpointed?.status, "active");

  const completed = store.complete(created.id, "Tests passed.");
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.result, "Tests passed.");
  assert.ok(completed?.completedAt);

  const reopened = store.get(created.id);
  assert.equal(reopened?.prompt, "Fix the issue.");
  assert.equal(reopened?.checkpoint, "Edited source; tests pending.");
  assert.equal(reopened?.result, "Tests passed.");
});

test("HostTaskStore keeps terminal tasks terminal", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-host-task-terminal-"));
  const store = new HostTaskStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const created = store.create({
    workspaceId: "ws_1",
    workspaceRoot: "/workspace",
    prompt: "Task.",
  });
  store.stop(created.id, "Cancelled.");
  const checkpointed = store.checkpoint(created.id, "Must not revive.");
  assert.equal(checkpointed?.status, "stopped");
  assert.equal(checkpointed?.checkpoint, undefined);
});
