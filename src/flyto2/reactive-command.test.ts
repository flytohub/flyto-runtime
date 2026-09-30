import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReactiveCommandRunner } from "./reactive-command.js";
import { RuntimeEventStore } from "./runtime-events.js";

test("reactive commands return immediately and publish shallow completion with evidence", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-"));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(async () => {
    runner.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
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
  const running = runner.get(receipt.job_id);
  assert.ok(running);
  assert.equal(running.status, "running");
  assert.ok(running.elapsed_ms >= 0);
  assert.ok(running.evidence_bytes >= 0);
  assert.ok(Date.parse(running.last_activity_at) > 0);
  assert.ok(running.idle_ms >= 0);

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

test("reactive command idle watchdog publishes process.stalled before termination", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-stall-"));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(async () => {
    runner.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const after = events.latestSequence();
  const receipt = runner.start({
    workspace_id: "ws-stall",
    workspace_root: stateDir,
    cwd: stateDir,
    command: "node -e \"setTimeout(() => process.exit(0), 5000)\"",
    timeout_seconds: 1,
    timeout_mode: "idle",
  });
  const stalled = await events.wait({
    after_sequence: after,
    workspace_id: "ws-stall",
    type: "process.stalled",
    correlation_id: receipt.job_id,
    timeout_ms: 3_000,
  });
  assert.equal(stalled?.type, "process.stalled");
  const snapshot = runner.get(receipt.job_id);
  assert.equal(snapshot?.status, "running");
  assert.equal(snapshot?.suspected_stall, true);
  runner.signal(receipt.job_id, "ws-stall", "SIGINT");
});

test("terminal reactive jobs can be discarded after a synchronous compatibility response", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-discard-"));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(async () => {
    runner.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
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

test("reactive command idle watchdog requires repeated no-progress observations before terminating", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-timeout-"));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(async () => {
    runner.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
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
  const evidence = runner.readEvidence(receipt.evidence_ref).text;
  assert.match(evidence, /process is still alive; extending the stall watchdog/i);
  assert.match(evidence, /across 3 adaptive watchdog observations/i);
});

test("adaptive idle timeout cannot be converted into success by a clean SIGTERM handler", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-timeout-clean-"));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(async () => {
    runner.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
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

test("idle timeout is refreshed by command progress instead of enforcing a wall-clock deadline", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-idle-timeout-"));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(async () => {
    runner.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const receipt = runner.start({
    workspace_id: "ws-idle-timeout",
    workspace_root: stateDir,
    cwd: stateDir,
    command:
      "node -e \"let n=0; const i=setInterval(()=>{process.stdout.write('tick\\n'); if(++n===4){clearInterval(i); process.exit(0)}},200)\"",
    timeout_seconds: 0.5,
  });
  const event = await events.wait({
    correlation_id: receipt.job_id,
    type: receipt.event_type,
    timeout_ms: 2_000,
  });

  assert.equal(event?.payload.success, true);
  assert.equal(event?.payload.timed_out, false);
  assert.equal(runner.get(receipt.job_id)?.status, "completed");
});

test("explicit deadline mode still enforces a hard wall-clock timeout", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-deadline-"));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(async () => {
    runner.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const receipt = runner.start({
    workspace_id: "ws-deadline",
    workspace_root: stateDir,
    cwd: stateDir,
    command: "node -e \"setInterval(()=>process.stdout.write('still-alive\\n'),25)\"",
    timeout_seconds: 0.1,
    timeout_mode: "deadline",
  });
  const event = await events.wait({
    correlation_id: receipt.job_id,
    type: receipt.event_type,
    timeout_ms: 2_000,
  });

  assert.equal(event?.payload.success, false);
  assert.equal(event?.payload.timed_out, true);
  assert.match(runner.readEvidence(receipt.evidence_ref).text, /timed out after 0\.1 seconds/i);
});

test("reactive command can be cancelled through the internal process boundary", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-signal-"));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(async () => {
    runner.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const receipt = runner.start({
    workspace_id: "ws-signal",
    workspace_root: stateDir,
    cwd: stateDir,
    command: "node -e \"setInterval(() => {}, 1000)\"",
  });
  assert.equal(runner.get(receipt.job_id)?.status, "running");
  runner.signal(receipt.job_id, "ws-signal", "SIGINT");

  const event = await events.wait({
    correlation_id: receipt.job_id,
    type: receipt.event_type,
    timeout_ms: 2_000,
  });
  assert.equal(event?.payload.success, false);
  assert.equal(runner.get(receipt.job_id)?.status, "failed");
});

test("Runtime restart marks an unresolved durable command orphaned without replay", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-restart-"));
  const firstEvents = new RuntimeEventStore(stateDir);
  const firstRunner = new ReactiveCommandRunner(stateDir, firstEvents);
  const receipt = firstRunner.start({
    workspace_id: "ws-restart",
    workspace_root: stateDir,
    cwd: stateDir,
    command: "node -e \"setInterval(() => {}, 1000)\"",
  });

  firstRunner.shutdown();
  firstEvents.close();

  const recoveredEvents = new RuntimeEventStore(stateDir);
  const recoveredRunner = new ReactiveCommandRunner(stateDir, recoveredEvents);
  try {
    const recovered = recoveredRunner.get(receipt.job_id);
    assert.equal(recovered?.status, "orphaned");
    const orphaned = recoveredEvents.list({
      correlation_id: receipt.job_id,
      type: "process.orphaned",
    });
    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0]?.payload.retry_safe, false);
  } finally {
    recoveredRunner.shutdown();
    recoveredEvents.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("reactive command failure emits failure facts without hiding evidence", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-reactive-"));
  const events = new RuntimeEventStore(stateDir);
  const runner = new ReactiveCommandRunner(stateDir, events);
  t.after(async () => {
    runner.shutdown();
    events.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const receipt = runner.start({
    workspace_id: "ws-2",
    workspace_root: stateDir,
    cwd: stateDir,
    command: "node -e \"process.stderr.write('boom\\\\n'); process.exit(7)\"",
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
