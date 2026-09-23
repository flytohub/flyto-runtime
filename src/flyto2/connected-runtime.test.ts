import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConnectedFlyto2Runtime,
  type Flyto2AssignmentExecutor,
  type Flyto2CloudAssignmentTransport,
} from "./connected-runtime.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  type Flyto2Assignment,
  type Flyto2RuntimeManifest,
} from "./protocol.js";
import { RuntimeEventStore } from "./runtime-events.js";

const manifest: Flyto2RuntimeManifest = {
  schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
  product: "Flyto2",
  runtime: "flyto-runtime",
  runtime_version: "1.0.8",
  runtime_id: "rt_0123456789abcdef0123456789abcdef",
  display_name: "Runtime",
  platform: "darwin",
  roles: ["executes_jobs"],
  capabilities: [],
};

const assignment: Flyto2Assignment = {
  schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
  assignment_id: "job-1",
  source: "flyto-cloud",
  workspace_id: "workspace-1",
  kind: "task",
  objective: "repair tests",
  payload: {},
  received_at: new Date().toISOString(),
};

test("connected runtime composes claim, lease, progress, executor and completion", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-connected-runtime-"));
  const events = new RuntimeEventStore(stateDir);
  t.after(async () => {
    events.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  let completed: unknown;
  const transport: Flyto2CloudAssignmentTransport = {
    async waitForAssignment() {
      return undefined;
    },
    async claim(id) {
      calls.push("claim:" + id);
      return { lease_id: "lease-1" };
    },
    async renewLease(id, lease) {
      calls.push("renew:" + id + ":" + lease);
    },
    async reportProgress(id, lease, progress) {
      calls.push("progress:" + id + ":" + lease + ":" + progress.status);
      return { cancel_requested: false };
    },
    async complete(id, lease, completion) {
      calls.push("complete:" + id + ":" + lease);
      completed = completion;
    },
  };
  const executor: Flyto2AssignmentExecutor = {
    async execute(received, context) {
      assert.equal(received.assignment_id, assignment.assignment_id);
      assert.equal(context.manifest.runtime_id, manifest.runtime_id);
      await context.reportProgress({ status: "running" });
      await new Promise((resolve) => setTimeout(resolve, 18));
      return { status: "success", variables: { result: "ok" } };
    },
  };

  const runtime = new ConnectedFlyto2Runtime(
    manifest,
    transport,
    executor,
    { leaseRenewIntervalMs: 5, events },
  );
  await runtime.executeAssignment(assignment);

  assert.equal(calls[0], "claim:job-1");
  assert.ok(calls.some((call) => call.startsWith("renew:job-1:lease-1")));
  assert.ok(calls.includes("progress:job-1:lease-1:running"));
  assert.equal(calls.at(-1), "complete:job-1:lease-1");
  assert.deepEqual(completed, {
    status: "success",
    variables: { result: "ok" },
  });
  assert.deepEqual(
    events.list({ workspace_id: "workspace-1" }).map(({ type }) => type),
    [
      "assignment.received",
      "assignment.claimed",
      "assignment.progress",
      "assignment.completed",
    ],
  );
  assert.ok(
    events.list({ workspace_id: "workspace-1" }).every(
      ({ correlation_id }) => correlation_id === "job-1",
    ),
  );
});

test("executor failure becomes a truthful failed Cloud completion", async () => {
  let completion: unknown;
  const transport: Flyto2CloudAssignmentTransport = {
    async waitForAssignment() {
      return undefined;
    },
    async claim() {
      return { lease_id: "lease-2" };
    },
    async renewLease() {},
    async reportProgress() {
      return { cancel_requested: false };
    },
    async complete(_id, _lease, value) {
      completion = value;
    },
  };
  const executor: Flyto2AssignmentExecutor = {
    async execute() {
      throw new Error("executor failed");
    },
  };

  const runtime = new ConnectedFlyto2Runtime(manifest, transport, executor);
  await runtime.executeAssignment(assignment);
  assert.deepEqual(completion, {
    status: "failed",
    error_message: "executor failed",
  });
});
