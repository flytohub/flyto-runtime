import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { writeTestDevspaceConfig } from "../test-support/config.test.js";
import {
  createInstalledAdapterTransport,
  joinRuntimeAndInstalledTransports,
  readInstalledAdapterManifest,
} from "./mobile-installed-adapters.js";
import type { Flyto2CapabilityTransport } from "./capability-transport.js";
import type { Flyto2CapabilityInvocation } from "./protocol.js";

test("operator-installed adapter executes without shell and returns independent evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-installed-mobile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { port: 1 },
    storage: { stateDir: join(root, "state") },
  }));
  const descriptor = {
    id: "robot.ros2.readiness", revision: 1,
    risk_level: "low" as const, approval: "policy" as const,
    evidence: ["ros2_graph_status"],
  };
  const js = [
    "let text='';",
    "process.stdin.on('data',x=>text+=x);",
    "process.stdin.on('end',()=>{const q=JSON.parse(text);",
    "process.stdout.write(JSON.stringify({schema:q.schema,invocation_id:q.invocation_id,",
    "capability:q.capability,revision:q.revision,status:'success',started_at:q.requested_at,",
    "completed_at:q.requested_at,output:{ready:false},evidence:[]}));});",
  ].join("");
  const manifestFile = join(root, "installed.json");
  await writeFile(manifestFile, JSON.stringify({
    schema: "flyto2.local-adapters.v1",
    adapters: [{
      capability: descriptor, executable: process.execPath, argv: ["-e", js],
      timeout_ms: 5000,
    }],
  }), { mode: 0o600 });
  const installed = createInstalledAdapterTransport(
    config, readInstalledAdapterManifest(manifestFile));
  assert.equal(installed.manifest().capabilities[0].id, descriptor.id);
  const request: Flyto2CapabilityInvocation = {
    schema: "flyto2.execution.v1",
    invocation_id: "robot-readiness-123",
    operation_id: "robot-operation-123",
    requested_at: "2026-10-10T00:00:00Z",
    capability: descriptor.id,
    revision: 1,
    input: {},
  };
  const result = await installed.invoke(request);
  assert.equal(result.status, "success");
  assert.equal(result.output.ready, false);
  assert.equal(result.invocation_id, request.invocation_id);

  const runtime: Flyto2CapabilityTransport = {
    manifest: () => ({
      ...installed.manifest(),
      capabilities: [{
        id: "source.read", revision: 1,
        risk_level: "low", approval: "policy", evidence: [],
      }],
    }),
    invoke: async () => { throw new Error("Wrong backend"); },
  };
  const combined = joinRuntimeAndInstalledTransports(runtime, installed);
  assert.deepEqual(combined.manifest().capabilities.map(x => x.id),
    ["source.read", descriptor.id]);
  assert.equal((await combined.invoke(request)).status, "success");
  assert.throws(() => joinRuntimeAndInstalledTransports(installed, installed),
    /Duplicate/);
});

test("adapter manifest requires regular, non-writable file and explicit binaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-installed-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestFile = join(root, "installed.json");
  await writeFile(manifestFile, JSON.stringify({
    schema: "flyto2.local-adapters.v1",
    adapters: [{
      capability: { id: "robot.status", revision: 1,
        risk_level: "low", approval: "policy", evidence: [] },
      executable: "/not/installed", argv: [],
    }],
  }), { mode: 0o600 });
  const alias = join(root, "alias.json");
  await symlink(manifestFile, alias);
  assert.throws(() => readInstalledAdapterManifest(alias), /regular local file/);
  if (process.platform !== "win32") {
    await chmod(manifestFile, 0o666);
    assert.throws(() => readInstalledAdapterManifest(manifestFile),
      /writable/);
  }
});
