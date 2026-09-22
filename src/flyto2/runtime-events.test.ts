import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeEventStore } from "./runtime-events.js";

test("runtime events are durable, ordered, deduplicated, and filterable", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-events-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const first = new RuntimeEventStore(stateDir, 10);
  const eventA = first.append({
    event_id: "evt-fixed-a",
    type: "workspace.changed",
    source: "mcp",
    workspace_id: "ws-1",
    summary: "changed",
    payload: { paths: ["a.ts"] },
  });
  const replay = first.append({
    event_id: "evt-fixed-a",
    type: "workspace.changed",
    source: "mcp",
    workspace_id: "ws-1",
    summary: "changed",
    payload: { paths: ["a.ts"] },
  });
  assert.throws(
    () => first.append({
      event_id: "evt-fixed-a",
      type: "workspace.changed",
      source: "mcp",
      workspace_id: "ws-1",
      summary: "different",
      payload: { paths: ["b.ts"] },
      occurred_at: eventA.occurred_at,
    }),
    /different Runtime event content/i,
  );
  first.append({
    event_id: "evt-fixed-b",
    type: "test.completed",
    source: "worker",
    workspace_id: "ws-2",
    summary: "done",
  });
  assert.equal(replay.sequence, eventA.sequence);
  first.close();

  const restored = new RuntimeEventStore(stateDir, 10);
  t.after(() => restored.close());
  assert.ok(restored.latestSequence() >= eventA.sequence + 1);
  assert.deepEqual(
    restored.list({ workspace_id: "ws-1" }).map(({ event_id }) => event_id),
    ["evt-fixed-a"],
  );
  assert.deepEqual(
    restored.list({ type: "test.completed" }).map(({ event_id }) => event_id),
    ["evt-fixed-b"],
  );
});

test("runtime wait returns one shallow matching event without polling", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-events-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new RuntimeEventStore(stateDir);
  t.after(() => store.close());

  const after = store.latestSequence();
  const waiting = store.wait({
    after_sequence: after,
    workspace_id: "ws-1",
    type: "process.exited",
    timeout_ms: 1_000,
  });

  store.append({
    type: "process.exited",
    source: "worker",
    workspace_id: "ws-2",
    summary: "other workspace",
  });
  setTimeout(() => {
    store.append({
      type: "process.exited",
      source: "worker",
      workspace_id: "ws-1",
      correlation_id: "job-1",
      summary: "command exited",
      payload: { exit_code: 0 },
    });
  }, 20);

  const event = await waiting;
  assert.equal(event?.workspace_id, "ws-1");
  assert.equal(event?.correlation_id, "job-1");
  assert.deepEqual(event?.payload, { exit_code: 0 });
});

test("runtime event retention keeps the newest bounded history", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-events-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new RuntimeEventStore(stateDir, 3);
  t.after(() => store.close());

  for (let index = 1; index <= 5; index += 1) {
    store.append({
      event_id: `evt-retain-${index}`,
      type: "custom",
      source: "test",
      summary: String(index),
    });
  }

  assert.deepEqual(
    store.list({ limit: 10 }).map(({ event_id }) => event_id),
    ["evt-retain-3", "evt-retain-4", "evt-retain-5"],
  );
});

test("runtime event payloads are bounded", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-events-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new RuntimeEventStore(stateDir);
  t.after(() => store.close());

  assert.throws(
    () => store.append({
      type: "too.large",
      source: "test",
      payload: { text: "x".repeat(70 * 1024) },
    }),
    /payload exceeds/i,
  );
});
