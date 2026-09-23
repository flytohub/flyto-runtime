import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import test from "node:test";
import { RuntimeEventStore } from "./runtime-events.js";
import { WorkspaceWatchRegistry } from "./workspace-watch.js";

test("external filesystem changes emit shallow workspace events and stop cleanly", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-watch-state-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "flyto2-watch-workspace-"));

  const file = join(workspaceRoot, "external.txt");
  await writeFile(file, "before\n");

  const events = new RuntimeEventStore(stateDir);
  const watches = new WorkspaceWatchRegistry(stateDir, events);
  t.after(async () => {
    watches.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const watch = watches.start({
    workspace_id: "ws-external",
    workspace_root: workspaceRoot,
    canonical_root: realpathSync(workspaceRoot),
    target_path: workspaceRoot,
    display_path: ".",
    recursive: true,
    debounce_ms: 40,
  });
  assert.equal(watch.status, "active");

  const cursor = events.latestSequence();
  const waiting = events.wait({
    after_sequence: cursor,
    workspace_id: "ws-external",
    type: "file.changed",
    timeout_ms: 2_000,
  });
  await writeFile(file, "after\n");

  const event = await waiting;
  assert.equal(event?.source, "fs.watch");
  assert.equal(event?.correlation_id, watch.watch_id);
  assert.doesNotMatch(JSON.stringify(event), /after\n/);
  const changes = (event?.payload.changes ?? []) as Array<{ path?: string }>;
  assert.ok(changes.some(({ path }) => path === "external.txt"));

  watches.stop(watch.watch_id);
  const stoppedCursor = events.latestSequence();
  await writeFile(file, "after-stop\n");
  const afterStop = await events.wait({
    after_sequence: stoppedCursor,
    workspace_id: "ws-external",
    type: "file.changed",
    timeout_ms: 150,
  });
  assert.equal(afterStop, undefined);
});

test("active filesystem watches restore after Runtime restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-watch-state-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "flyto2-watch-workspace-"));

  const file = join(workspaceRoot, "restore.txt");
  await writeFile(file, "before\n");

  const events = new RuntimeEventStore(stateDir);
  const first = new WorkspaceWatchRegistry(stateDir, events);
  const watch = first.start({
    workspace_id: "ws-restore",
    workspace_root: workspaceRoot,
    canonical_root: realpathSync(workspaceRoot),
    target_path: file,
    display_path: "restore.txt",
    recursive: false,
    debounce_ms: 40,
  });
  first.shutdown();

  const restored = new WorkspaceWatchRegistry(stateDir, events);
  t.after(async () => {
    restored.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  assert.equal(
    restored.list("ws-restore").find(({ watch_id }) => watch_id === watch.watch_id)?.status,
    "active",
  );

  const cursor = events.latestSequence();
  const waiting = events.wait({
    after_sequence: cursor,
    workspace_id: "ws-restore",
    type: "file.changed",
    timeout_ms: 2_000,
  });
  await writeFile(file, "after-restart\n");
  const event = await waiting;
  assert.equal(event?.correlation_id, watch.watch_id);
});

test("persisted watch fails closed when a logical workspace root retargets", {
  skip: platform() === "win32",
}, async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-watch-state-"));
  const parent = await mkdtemp(join(tmpdir(), "flyto2-watch-symlink-"));
  const rootA = join(parent, "a");
  const rootB = join(parent, "b");
  const logicalRoot = join(parent, "workspace");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(rootA), mkdir(rootB)]),
  );
  await writeFile(join(rootA, "file.txt"), "a\n");
  await writeFile(join(rootB, "file.txt"), "b\n");
  await symlink(rootA, logicalRoot, "dir");

  const events = new RuntimeEventStore(stateDir);
  const first = new WorkspaceWatchRegistry(stateDir, events);
  const watch = first.start({
    workspace_id: "ws-retarget",
    workspace_root: logicalRoot,
    canonical_root: realpathSync(logicalRoot),
    target_path: join(rootA, "file.txt"),
    display_path: "file.txt",
    recursive: false,
  });
  first.shutdown();

  await unlink(logicalRoot);
  await symlink(rootB, logicalRoot, "dir");

  const cursor = events.latestSequence();
  const restored = new WorkspaceWatchRegistry(stateDir, events);
  t.after(async () => {
    restored.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  });

  const record = restored
    .list("ws-retarget")
    .find(({ watch_id }) => watch_id === watch.watch_id);
  assert.equal(record?.status, "error");

  const error = events.list({
    after_sequence: cursor,
    workspace_id: "ws-retarget",
    type: "watch.error",
  })[0];
  assert.equal(error?.correlation_id, watch.watch_id);
  assert.match(
    String((error?.payload ?? {}).error),
    /canonical identity changed/i,
  );
});
