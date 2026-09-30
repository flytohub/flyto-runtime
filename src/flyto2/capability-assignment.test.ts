import assert from "node:assert/strict";
import test from "node:test";
import { Flyto2CapabilityAssignmentExecutor } from "./capability-assignment.js";
import type { Flyto2CapabilityTransport } from "./capability-transport.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  type Flyto2Assignment,
  type Flyto2CapabilityInvocation,
  type Flyto2CapabilityResult,
  type Flyto2RuntimeManifest,
} from "./protocol.js";

test("Cloud capability adapter waits through contract follow-ups and replays the original operation to terminal state", async () => {
  const calls: Flyto2CapabilityInvocation[] = [];
  let originalCalls = 0;
  const transport: Flyto2CapabilityTransport = {
    manifest: () => manifest(["test.run", "event.wait"]),
    async invoke(invocation) {
      calls.push(invocation);
      if (invocation.capability === "event.wait") {
        return successResult(invocation, { matched: true });
      }
      originalCalls += 1;
      if (originalCalls === 1) {
        return {
          schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
          invocation_id: invocation.invocation_id,
          capability: invocation.capability,
          revision: 1,
          status: "accepted",
          started_at: "2026-09-30T00:00:00.000Z",
          output: {},
          evidence: [],
          operation: {
            kind: "process",
            ref: "proc_0123456789abcdef0123456789abcdef",
            state: "running",
            wait: {
              capability: "event.wait",
              input: {
                workspace_id: "ws-local",
                correlation_id: "job_0123456789abcdef0123456789abcdef",
                type: "capability.test.exited",
              },
            },
          },
        };
      }
      return successResult(invocation, { exit_code: 0 });
    },
  };
  const executor = new Flyto2CapabilityAssignmentExecutor(transport);
  const progress: unknown[] = [];
  const completion = await executor.execute(assignment(), {
    manifest: transport.manifest(),
    leaseId: "lease-1",
    async reportProgress(value) {
      progress.push(value);
      return { cancel_requested: false };
    },
  });

  assert.equal(completion.status, "success");
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.operation_id, calls[2]?.operation_id);
  assert.equal(calls[1]?.capability, "event.wait");
  assert.equal(progress.length, 1);
});

test("Cloud capability adapter rejects capabilities not exposed by the live manifest", async () => {
  const transport: Flyto2CapabilityTransport = {
    manifest: () => manifest([]),
    async invoke() {
      throw new Error("should not execute");
    },
  };
  const executor = new Flyto2CapabilityAssignmentExecutor(transport);
  const completion = await executor.execute(assignment(), {
    manifest: transport.manifest(),
    leaseId: "lease-1",
    async reportProgress() {
      return { cancel_requested: false };
    },
  });
  assert.equal(completion.status, "failed");
  assert.equal(completion.failure?.code, "capability_unavailable");
});

function assignment(): Flyto2Assignment {
  return {
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    assignment_id: "assignment-1",
    source: "flyto-cloud",
    kind: "capability",
    objective: "run tests",
    received_at: "2026-09-30T00:00:00.000Z",
    payload: {
      capability_invocation: {
        schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
        invocation_id: "cloud-invocation",
        capability: "test.run",
        revision: 1,
        operation_id: "cloud-operation-1",
        requested_at: "2026-09-30T00:00:00.000Z",
        input: { workspace_id: "ws-local" },
      },
    },
  };
}

function manifest(capabilities: string[]): Flyto2RuntimeManifest {
  return {
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    product: "Flyto2",
    runtime: "flyto-runtime",
    runtime_version: "1.1.4",
    runtime_id: "rt_0123456789abcdef0123456789abcdef",
    display_name: "test runtime",
    platform: "test",
    roles: ["executes_jobs"],
    capabilities: capabilities.map((id) => ({
      id,
      revision: 1,
      risk_level: "low",
      approval: "none",
      evidence: [],
    })),
  };
}

function successResult(
  invocation: Flyto2CapabilityInvocation,
  output: Record<string, unknown>,
): Flyto2CapabilityResult {
  return {
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    invocation_id: invocation.invocation_id,
    capability: invocation.capability,
    revision: invocation.revision,
    status: "success",
    started_at: "2026-09-30T00:00:00.000Z",
    completed_at: "2026-09-30T00:00:01.000Z",
    output,
    evidence: [],
  };
}
