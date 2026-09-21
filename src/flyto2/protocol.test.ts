import assert from "node:assert/strict";
import test from "node:test";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  flyto2RuntimeManifestSchema,
  normalizeCloudJob,
} from "./protocol.js";

test("Flyto2 execution protocol manifest is standalone and versioned", () => {
  const manifest = flyto2RuntimeManifestSchema.parse({
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    product: "Flyto2",
    runtime: "flyto-runtime",
    runtime_version: "1.0.8",
    runtime_id: "rt_0123456789abcdef0123456789abcdef",
    display_name: "Mac",
    platform: "darwin",
    roles: ["executes_jobs"],
    capabilities: [
      {
        id: "source.edit",
        revision: 1,
        risk_level: "high",
        approval: "policy",
        evidence: ["diff"],
      },
    ],
  });

  assert.equal(manifest.product, "Flyto2");
  assert.equal(manifest.runtime, "flyto-runtime");
  assert.equal(manifest.capabilities[0]?.id, "source.edit");
});

test("Cloud jobs normalize into a provider-neutral Flyto2 assignment", () => {
  const assignment = normalizeCloudJob({
    id: "job-1",
    objective: "fix the failing tests",
    trace_id: "trace-1",
    private_cloud_field: { preserved: true },
  }, "workspace-1");

  assert.equal(assignment.schema, FLYTO2_EXECUTION_PROTOCOL_VERSION);
  assert.equal(assignment.assignment_id, "job-1");
  assert.equal(assignment.workspace_id, "workspace-1");
  assert.equal(assignment.kind, "task");
  assert.equal(assignment.objective, "fix the failing tests");
  assert.deepEqual(
    (assignment.payload.private_cloud_field as { preserved?: boolean }).preserved,
    true,
  );
});
