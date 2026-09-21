import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Flyto2CloudBridge } from "./cloud-bridge.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  type Flyto2RuntimeManifest,
} from "./protocol.js";

const manifest: Flyto2RuntimeManifest = {
  schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
  product: "Flyto2",
  runtime: "flyto-runtime",
  runtime_version: "1.0.8",
  runtime_id: "rt_0123456789abcdef0123456789abcdef",
  display_name: "Chester Mac",
  platform: "darwin",
  roles: ["executes_jobs"],
  capabilities: [],
};

test("Cloud bridge pairs once, persists 0600 credentials, and normalizes assignments", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-runtime-cloud-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/devices/pair/claim")) {
      return Response.json({
        device_id: "device-1",
        device_secret: "secret-1",
        workspace_id: "workspace-1",
        workspace_name: "Workspace",
      });
    }
    if (url.includes("/api/devices/jobs/poll")) {
      return Response.json({
        job: {
          id: "job-1",
          objective: "repair CI",
          trace_id: "trace-1",
        },
      });
    }
    throw new Error("unexpected request " + url);
  };

  const bridge = new Flyto2CloudBridge({ stateDir }, fakeFetch);
  assert.equal(bridge.paired, false);
  const paired = await bridge.pair("pair-code", manifest, "http://127.0.0.1:9999");
  assert.equal(paired.device_id, "device-1");
  assert.equal(bridge.paired, true);

  const credentialPath = join(stateDir, "flyto2-cloud.json");
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(credentialPath, "utf8")) as Record<string, unknown>;
  assert.equal(stored.device_secret, "secret-1");

  const restored = new Flyto2CloudBridge({ stateDir }, fakeFetch);
  const assignment = await restored.waitForAssignment();
  assert.equal(assignment?.assignment_id, "job-1");
  assert.equal(assignment?.kind, "task");
  assert.equal(assignment?.objective, "repair CI");

  const poll = calls.find(({ url }) => url.includes("/api/devices/jobs/poll"));
  const headers = new Headers(poll?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer device:device-1.secret-1");
});
