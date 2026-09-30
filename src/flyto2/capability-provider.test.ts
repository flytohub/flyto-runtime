import assert from "node:assert/strict";
import test from "node:test";
import { runtimeEventCapabilityAuditSink } from "./capability-audit.js";
import { runtimeCapabilityCatalog } from "./capability-catalog.js";
import {
  RuntimeCapabilityRegistry,
  type RuntimeCapabilityAuditRecord,
} from "./capability-provider.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  type Flyto2CapabilityInvocation,
} from "./protocol.js";

const invocation: Flyto2CapabilityInvocation = {
  schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
  invocation_id: "invocation-1",
  capability: "source.read",
  revision: 1,
  operation_id: "operation-1",
  workspace_id: "workspace-1",
  trace_id: "trace-1",
  requested_at: new Date().toISOString(),
  input: { path: "README.md" },
};

test("runtime capability catalog has stable unique id and revision pairs", () => {
  const catalog = runtimeCapabilityCatalog();
  const keys = catalog.map(({ id, revision }) => `${id}@${revision}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("source.read@1"));
  assert.ok(keys.includes("source.edit@1"));
  assert.ok(keys.includes("process.run@1"));
  assert.ok(keys.includes("process.status@1"));
  assert.equal(catalog.find(({ id }) => id === "test.run")?.approval, "policy");
  assert.equal(catalog.find(({ id }) => id === "build.run")?.approval, "policy");
  assert.equal(catalog.find(({ id }) => id === "evidence.read")?.approval, "policy");
});

test("registry admits only catalog-matching providers", () => {
  const registry = new RuntimeCapabilityRegistry(runtimeCapabilityCatalog());
  const read = runtimeCapabilityCatalog().find(({ id }) => id === "source.read");
  assert.ok(read);
  assert.throws(() => registry.register({
    capability: { ...read, approval: "explicit" },
    async execute() {
      return { status: "success" };
    },
  }), /metadata does not match the catalog/);
});

test("registry executes a provider through the stable capability contract and emits shallow audit records", async () => {
  const records: RuntimeCapabilityAuditRecord[] = [];
  const registry = new RuntimeCapabilityRegistry(runtimeCapabilityCatalog(), {
    append(record) {
      records.push(record);
    },
  });
  const read = runtimeCapabilityCatalog().find(({ id }) => id === "source.read");
  assert.ok(read);
  registry.register({
    capability: read,
    async execute(input, context) {
      assert.deepEqual(input, { path: "README.md" });
      assert.equal(context.invocation.operation_id, "operation-1");
      return {
        status: "success",
        output: { bytes: 42 },
        evidence: [{ kind: "file", ref: "README.md" }],
      };
    },
  });

  const result = await registry.execute(invocation);
  assert.equal(result.status, "success");
  assert.deepEqual(result.output, { bytes: 42 });
  assert.deepEqual(records.map(({ type }) => type), [
    "capability.started",
    "capability.completed",
  ]);
  assert.ok(records.every(({ invocation_id }) => invocation_id === "invocation-1"));
  assert.equal(records[1]?.operation_id, "operation-1");
});

test("provider exceptions become explicit failed results and audit records", async () => {
  const records: RuntimeCapabilityAuditRecord[] = [];
  const registry = new RuntimeCapabilityRegistry(runtimeCapabilityCatalog(), {
    append(record) {
      records.push(record);
    },
  });
  const read = runtimeCapabilityCatalog().find(({ id }) => id === "source.read");
  assert.ok(read);
  registry.register({
    capability: read,
    async execute() {
      throw new Error("read failed");
    },
  });

  const result = await registry.execute(invocation);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "provider_error");
  assert.equal(result.failure?.detail, "read failed");
  assert.deepEqual(records.map(({ type }) => type), [
    "capability.started",
    "capability.failed",
  ]);
});

test("accepted capability results carry a durable operation handle and non-terminal audit state", async () => {
  const records: RuntimeCapabilityAuditRecord[] = [];
  const registry = new RuntimeCapabilityRegistry(runtimeCapabilityCatalog(), {
    append(record) {
      records.push(record);
    },
  });
  const process = runtimeCapabilityCatalog().find(({ id }) => id === "process.run");
  assert.ok(process);
  registry.register({
    capability: process,
    async execute() {
      return {
        status: "accepted",
        operation: { kind: "process", ref: "proc_0123456789abcdef0123456789abcdef", state: "running" },
        output: { queued: true },
      };
    },
  });

  const result = await registry.execute({
    ...invocation,
    invocation_id: "accepted-1",
    capability: "process.run",
    operation_id: "operation-accepted-1",
  });
  assert.equal(result.status, "accepted");
  assert.equal(result.completed_at, undefined);
  assert.equal(result.operation?.kind, "process");
  assert.deepEqual(records.map(({ type }) => type), [
    "capability.started",
    "capability.accepted",
  ]);
});

test("Runtime event adapter records capability metadata without input or output payloads", () => {
  const appended: unknown[] = [];
  const sink = runtimeEventCapabilityAuditSink({
    append(value: unknown) {
      appended.push(value);
      return value;
    },
  } as never);

  sink.append({
    type: "capability.completed",
    invocation_id: "invocation-1",
    capability: "source.read",
    revision: 1,
    operation_id: "operation-1",
    workspace_id: "workspace-1",
    trace_id: "trace-1",
    occurred_at: "2026-09-30T00:00:00.000Z",
    duration_ms: 10,
    evidence: [{ kind: "file", ref: "README.md" }],
  });

  assert.deepEqual(appended, [{
    type: "capability.completed",
    source: "runtime-capability",
    workspace_id: "workspace-1",
    correlation_id: "invocation-1",
    summary: "Runtime capability source.read@1 completed.",
    payload: {
      invocation_id: "invocation-1",
      capability: "source.read",
      revision: 1,
      operation_id: "operation-1",
      trace_id: "trace-1",
      duration_ms: 10,
    },
    evidence: [{ kind: "file", ref: "README.md" }],
    occurred_at: "2026-09-30T00:00:00.000Z",
  }]);
});
