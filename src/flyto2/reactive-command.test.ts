import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReactiveCommandRunner } from "./reactive-command.js";
import { RuntimeEventStore } from "./runtime-events.js";

test("reactive commands return immediately and publish shallow completion with evidence", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(() => {
    runner.shutdown();
    events.close();
  });

  const after = events.latestSequence();
  const receipt = runner.start({
    workspace_id: "ws-1",
    workspace_root: stateDir,
    cwd: stateDir,
    command: "printf 'hello-reactor\\n'",
    event_type: "test.completed",
  });

  assert.equal(receipt.status, "running");
  assert.equal(receipt.event_type, "test.completed");
  assert.match(receipt.evidence_ref, /^flyto2:\/\/evidence\/job_/);

  const event = await events.wait({
    after_sequence: after,
    workspace_id: "ws-1",
    type: "test.completed",
    timeout_ms: 2_000,
  });

  assert.equal(event?.correlation_id, receipt.job_id);
  assert.equal(event?.payload.success, true);
  assert.equal(event?.payload.exit_code, 0);
  assert.doesNotMatch(
    JSON.stringify(event),
    /hello-reactor/,
    "shallow event must not inject command output",
  );

  const evidence = runner.readEvidence(receipt.evidence_ref);
  assert.match(evidence.text, /hello-reactor/);
  assert.equal(evidence.job.status, "completed");
});

test("reactive command failure emits failure facts without hiding evidence", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(() => {
    runner.shutdown();
    events.close();
  });

  const receipt = runner.start({
    workspace_id: "ws-2",
    workspace_root: stateDir,
    cwd: stateDir,
    command: "printf 'boom\\n' >&2; exit 7",
  });

  const event = await events.wait({
    after_sequence: 0,
    workspace_id: "ws-2",
    type: "process.exited",
    timeout_ms: 2_000,
  });
  assert.equal(event?.payload.success, false);
  assert.equal(event?.payload.exit_code, 7);
  assert.match(runner.readEvidence(receipt.evidence_ref).text, /boom/);
  assert.equal(runner.get(receipt.job_id)?.status, "failed");
});
