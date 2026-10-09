import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { Flyto2CapabilityTransport } from "./capability-transport.js";
import { createMobileCompanionGateway, MOBILE_COMPANION_BASE } from "./mobile-companion-gateway.js";
import type { Flyto2RuntimeManifest, Flyto2CapabilityInvocation } from "./protocol.js";

const capabilities: Flyto2RuntimeManifest["capabilities"] = [
  { id: "source.read", revision: 1, risk_level: "low", approval: "policy", evidence: ["file_sha256"] },
  { id: "motion.advance", revision: 1, risk_level: "high", approval: "explicit", evidence: ["robot_pose"] },
  { id: "unsafe.write", revision: 1, risk_level: "medium", approval: "explicit", evidence: [] },
];
const manifest: Flyto2RuntimeManifest = {
  schema: "flyto2.execution.v1", product: "Flyto2", runtime: "flyto-runtime",
  runtime_version: "0.1", runtime_id: "rt_test", display_name: "test-host",
  platform: "darwin", roles: ["executes_jobs"], capabilities,
};
const invocation: Flyto2CapabilityInvocation = {
  schema: "flyto2.execution.v1", invocation_id: "invocation-123",
  capability: "source.read", revision: 1,
  operation_id: "local-operation-123", requested_at: "2026-10-10T00:00:00Z",
  input: { path: "README.md" },
};
const postHeaders = { "content-type": "application/json" };

async function fixture(now: () => number = Date.now) {
  const called: Flyto2CapabilityInvocation[] = [];
  const transport: Flyto2CapabilityTransport = {
    manifest: () => manifest,
    invoke: async (request) => {
      called.push(request);
      await new Promise(resolve => setTimeout(resolve, 8));
      return {
        schema: "flyto2.execution.v1", invocation_id: request.invocation_id,
        capability: request.capability, revision: request.revision,
        status: "success", started_at: "2026-10-10T00:00:00Z",
        completed_at: "2026-10-10T00:00:01Z", output: { read: true }, evidence: [],
      };
    },
  };
  // HTTP only in this loopback test fixture; production startup demands TLS.
  const server = createServer(createMobileCompanionGateway({
    transport,
    pairingCode: "12345678",
    allowedCapabilities: new Set(["source.read", "motion.advance", "unsafe.write"]),
    now,
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local listener");
  return {
    called,
    origin: "http://127.0.0.1:" + address.port + MOBILE_COMPANION_BASE,
    close: () => new Promise<void>((resolve, reject) =>
      server.close(err => err ? reject(err) : resolve())),
  };
}

async function pair(origin: string, code = "12345678") {
  const response = await fetch(origin + "/pair", {
    method: "POST", headers: postHeaders, body: JSON.stringify({ code }),
  });
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}

test("no anonymous manifest and no credentials leaked to the response", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await fetch(f.origin + "/manifest")).status, 401);
  assert.equal((await fetch(f.origin + "/invoke", {
    method: "POST", headers: postHeaders, body: JSON.stringify(invocation),
  })).status, 401);
  const result = await pair(f.origin);
  assert.equal(result.status, 200);
  assert.equal(result.data.schema, "flyto2.mobile-pairing.v1");
  assert.match(result.data.access_token as string, /^[A-Za-z0-9_-]{40,128}$/);
  assert.ok(!JSON.stringify(result.data).includes("bridge"));
});

test("wrong codes exhaust pairing, and correct code cannot be reused", async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (let i = 0; i < 5; i++) {
    assert.equal((await pair(f.origin, "00000000")).status, 403);
  }
  assert.equal((await pair(f.origin)).status, 403);
  const fresh = await fixture();
  t.after(fresh.close);
  assert.equal((await pair(fresh.origin)).status, 200);
  assert.equal((await pair(fresh.origin)).status, 403);
});

test("pairing expires and sessions expire without silent refresh", async (t) => {
  let ms = 0;
  const f = await fixture(() => ms);
  t.after(f.close);
  ms = 120_001;
  assert.equal((await pair(f.origin)).status, 403);
  let current = 0;
  const another = await fixture(() => current);
  t.after(another.close);
  const token = (await pair(another.origin)).data.access_token as string;
  current += 30 * 60_000 + 1;
  assert.equal((await fetch(another.origin + "/manifest", {
    headers: { authorization: "Bearer " + token },
  })).status, 401);
});

test("registered allowlist filters unsafe capabilities; invocation is idempotent", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const token = (await pair(f.origin)).data.access_token as string;
  const headers = { ...postHeaders, authorization: "Bearer " + token };
  const response = await fetch(f.origin + "/manifest", { headers });
  assert.equal(response.status, 200);
  const visible = await response.json() as { capabilities: { id: string }[] };
  assert.deepEqual(visible.capabilities.map(x => x.id), ["source.read"]);
  const run = () => fetch(f.origin + "/invoke", {
    method: "POST", headers, body: JSON.stringify(invocation),
  });
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(f.called.length, 1);
  const conflict = await fetch(f.origin + "/invoke", {
    method: "POST", headers, body: JSON.stringify({
      ...invocation, input: { path: "other.txt" },
    }),
  });
  assert.equal(conflict.status, 409);
  const forbidden = await fetch(f.origin + "/invoke", {
    method: "POST", headers, body: JSON.stringify({
      ...invocation, capability: "motion.advance", operation_id: "motion-12345",
    }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(f.called.length, 1);
  const unpair = await fetch(f.origin + "/unpair", { method: "POST", headers });
  assert.equal(unpair.status, 200);
  assert.equal((await fetch(f.origin + "/manifest", { headers })).status, 401);
});
