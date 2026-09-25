import assert from "node:assert/strict";
import test from "node:test";
import { waitForRestartReadiness } from "./restart-readiness.js";

function healthResponse(ok = true): Response {
  return new Response(JSON.stringify(
    ok ? { ok: true, name: "flyto2-runtime" } : { ok: false, name: "other" },
  ), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("restart readiness waits for tunnel and requires consecutive public successes", async () => {
  let tunnelChecks = 0;
  let healthChecks = 0;
  let mcpChecks = 0;
  let sleeps = 0;

  await waitForRestartReadiness({
    publicBaseUrl: "https://runtime.example.com/",
    tunnelReadiness: async () => {
      tunnelChecks += 1;
      return {
        configured: true,
        connector_count: 2,
        ready_connectors: tunnelChecks === 1 ? 1 : 2,
      };
    },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/healthz")) {
        healthChecks += 1;
        return healthResponse(true);
      }
      mcpChecks += 1;
      return new Response("", { status: 401 });
    },
    attempts: 5,
    intervalMs: 1,
    requiredConsecutiveSuccesses: 2,
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(tunnelChecks, 3);
  assert.equal(healthChecks, 3);
  assert.equal(mcpChecks, 3);
  assert.equal(sleeps, 2);
});

test("restart readiness accepts a public MCP OAuth rejection as route readiness", async () => {
  await waitForRestartReadiness({
    publicBaseUrl: "https://runtime.example.com/",
    tunnelReadiness: async () => ({
      configured: false,
      connector_count: 0,
      ready_connectors: 0,
    }),
    fetchImpl: async (input) => (
      String(input).endsWith("/healthz")
        ? healthResponse(true)
        : new Response("", { status: 401 })
    ),
    attempts: 1,
    requiredConsecutiveSuccesses: 1,
  });
});

test("restart readiness fails closed while public MCP is still unavailable", async () => {
  await assert.rejects(
    waitForRestartReadiness({
      publicBaseUrl: "https://runtime.example.com/",
      tunnelReadiness: async () => ({
        configured: true,
        connector_count: 2,
        ready_connectors: 2,
      }),
      fetchImpl: async (input) => (
        String(input).endsWith("/healthz")
          ? healthResponse(true)
          : new Response("bad gateway", { status: 502 })
      ),
      attempts: 2,
      intervalMs: 1,
      requiredConsecutiveSuccesses: 1,
      sleep: async () => undefined,
    }),
    /public MCP recovery did not stabilize/,
  );
});
