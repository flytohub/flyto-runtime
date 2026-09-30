import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ServerConfig } from "../config.js";
import { runtimeCapabilityCatalog } from "./capability-catalog.js";
import { RuntimeCapabilityRegistry } from "./capability-provider.js";
import { registryCapabilityTransport } from "./capability-transport.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  type Flyto2CapabilityInvocation,
} from "./protocol.js";

test("registry transport exposes only registered providers and invokes the same contract", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-capability-transport-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const registry = new RuntimeCapabilityRegistry(runtimeCapabilityCatalog());
  const sourceRead = runtimeCapabilityCatalog().find(({ id }) => id === "source.read");
  assert.ok(sourceRead);
  registry.register({
    capability: sourceRead,
    async execute() {
      return { status: "success", output: { value: "ok" } };
    },
  });
  const transport = registryCapabilityTransport({
    stateDir,
  } as ServerConfig, registry);
  assert.deepEqual(transport.manifest().capabilities.map(({ id }) => id), ["source.read"]);

  const result = await transport.invoke(invocation("source.read"));
  assert.equal(result.status, "success");
  assert.deepEqual(result.output, { value: "ok" });
});

function invocation(capability: string): Flyto2CapabilityInvocation {
  return {
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    invocation_id: "transport-invocation",
    capability,
    revision: 1,
    operation_id: "transport-operation",
    requested_at: "2026-09-30T00:00:00.000Z",
    input: {},
  };
}
