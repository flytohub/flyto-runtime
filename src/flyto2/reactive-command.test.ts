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

test("terminal reactive jobs can be discarded after a synchronous compatibility response", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-discard-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(() => {
    runner.shutdown();
    events.close();
  });

  const receipt = runner.start({
    workspace_id: "ws-discard",
    workspace_root: stateDir,
    cwd: stateDir,
    command: "printf 'temporary-evidence\\n'",
  });
  await events.wait({
    correlation_id: receipt.job_id,
    type: receipt.event_type,
    timeout_ms: 2_000,
  });

  assert.equal(runner.get(receipt.job_id)?.status, "completed");
  assert.equal(runner.discardTerminal(receipt.job_id), true);
  assert.equal(runner.get(receipt.job_id), undefined);
  assert.deepEqual(events.list({ correlation_id: receipt.job_id }), []);
  assert.throws(
    () => runner.readEvidence(receipt.evidence_ref),
    /Unknown reactive job evidence/,
  );
});

test("reactive command timeout terminates the process and records timeout evidence", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-timeout-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(() => {
    runner.shutdown();
    events.close();
  });

  const receipt = runner.start({
    workspace_id: "ws-timeout",
    workspace_root: stateDir,
    cwd: stateDir,
    command: "node -e \"setInterval(() => {}, 1000)\"",
    timeout_seconds: 0.1,
  });
  const event = await events.wait({
    correlation_id: receipt.job_id,
    type: receipt.event_type,
    timeout_ms: 2_000,
  });

  assert.equal(event?.payload.success, false);
  assert.equal(event?.payload.timed_out, true);
  assert.match(
    runner.readEvidence(receipt.evidence_ref).text,
    /timed out after 0\.1 seconds/i,
  );
});

test("reactive timeout cannot be converted into success by a clean SIGTERM handler", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-timeout-clean-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(() => {
    runner.shutdown();
    events.close();
  });

  const receipt = runner.start({
    workspace_id: "ws-timeout-clean",
    workspace_root: stateDir,
    cwd: stateDir,
    command:
      "node -e \"process.on('SIGTERM',()=>process.exit(0)); setInterval(() => {}, 1000)\"",
    timeout_seconds: 0.1,
  });
  const event = await events.wait({
    correlation_id: receipt.job_id,
    type: receipt.event_type,
    timeout_ms: 2_000,
  });

  assert.equal(event?.payload.timed_out, true);
  assert.equal(event?.payload.success, false);
  assert.equal(runner.get(receipt.job_id)?.status, "failed");
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
