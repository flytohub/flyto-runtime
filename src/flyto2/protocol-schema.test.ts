import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  flyto2AssignmentSchema,
  flyto2CapabilityInvocationSchema,
  flyto2CapabilityResultSchema,
  flyto2RuntimeEventSchema,
  flyto2RuntimeManifestSchema,
} from "./protocol.js";
import {
  FLYTO2_EXECUTION_SCHEMA_NAMES,
  flyto2ExecutionJsonSchema,
} from "./protocol-schema.js";

const schemaRoot = new URL("../../schema/flyto2.execution.v1/", import.meta.url);

test("checked-in Flyto2 execution JSON Schemas do not drift from the Zod contract", () => {
  for (const name of FLYTO2_EXECUTION_SCHEMA_NAMES) {
    const generated = `${JSON.stringify(flyto2ExecutionJsonSchema(name), null, 2)}\n`;
    const committed = readFileSync(
      new URL(`${name}.schema.json`, schemaRoot),
      "utf8",
    ).replace(/\r\n/g, "\n");
    assert.equal(
      committed,
      generated,
      `run \`npm run schema:flyto2\` after changing the ${name} protocol schema`,
    );
  }
});

test("cross-language protocol fixtures remain valid provider-neutral envelopes", () => {
  const manifest = flyto2RuntimeManifestSchema.parse(fixture("runtime-manifest.json"));
  const invocation = flyto2CapabilityInvocationSchema.parse(fixture("capability-invocation.json"));
  const success = flyto2CapabilityResultSchema.parse(fixture("capability-result-success.json"));
  const accepted = flyto2CapabilityResultSchema.parse(fixture("capability-result-accepted.json"));
  const assignment = flyto2AssignmentSchema.parse(fixture("capability-assignment.json"));
  const event = flyto2RuntimeEventSchema.parse(fixture("runtime-event.json"));

  assert.deepEqual(manifest.capabilities.map(({ id }) => id), ["source.read", "test.run"]);
  assert.equal(invocation.capability, "test.run");
  assert.equal(success.status, "success");
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.operation?.wait?.capability, "event.wait");
  assert.equal(accepted.operation?.inspect?.capability, "process.status");
  assert.equal(assignment.kind, "capability");
  assert.equal(event.type, "capability.test.exited");

  const serialized = JSON.stringify({ manifest, invocation, success, accepted, assignment, event });
  assert.doesNotMatch(serialized, /Users\//);
  assert.doesNotMatch(serialized, /device_secret|access_token|password/i);
});

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}`, schemaRoot), "utf8"));
}
