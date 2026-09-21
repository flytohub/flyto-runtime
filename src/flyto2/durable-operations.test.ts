import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableOperationStore, runDurableOperation } from "./durable-operations.js";

test("durable operation admission is atomic across store instances", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-durable-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const first = new DurableOperationStore(stateDir);
  const second = new DurableOperationStore(stateDir);
  t.after(() => first.close());
  t.after(() => second.close());

  const admitted = first.begin("write", "op.atomic.0001", { path: "a.txt", content: "a" });
  assert.equal(admitted.mode, "execute");

  assert.throws(
    () => second.begin("write", "op.atomic.0001", { path: "a.txt", content: "a" }),
    /in-flight or uncertain/i,
  );
  assert.throws(
    () => second.begin("write", "op.atomic.0001", { path: "a.txt", content: "b" }),
    /different arguments/i,
  );
});

test("completed durable operation replays its stored value", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-durable-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new DurableOperationStore(stateDir);
  t.after(() => store.close());

  let calls = 0;
  const first = await runDurableOperation(
    store,
    { tool: "edit", operationId: "op.replay.0001", payload: { file: "a.ts" } },
    async () => {
      calls += 1;
      return { status: "applied" };
    },
  );
  const replay = await runDurableOperation(
    store,
    { tool: "edit", operationId: "op.replay.0001", payload: { file: "a.ts" } },
    async () => {
      calls += 1;
      return { status: "duplicate" };
    },
  );

  assert.equal(calls, 1);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, { status: "applied" });
});
