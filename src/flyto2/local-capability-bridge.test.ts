import assert from "node:assert/strict";
import { stat, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { Flyto2CapabilityTransport } from "./capability-transport.js";
import {
  ensureLocalCapabilityBridgeToken,
  LOCAL_CAPABILITY_BRIDGE_BASE_PATH,
  LOCAL_CAPABILITY_BRIDGE_TOKEN_HEADER,
  localCapabilityBridgeTokenPath,
  registerLocalCapabilityBridge,
} from "./local-capability-bridge.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  type Flyto2CapabilityInvocation,
} from "./protocol.js";

test("local capability bridge is token-authenticated, loopback-only, and provider-neutral", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-capability-bridge-"));
  const invocations: Flyto2CapabilityInvocation[] = [];
  const transport: Flyto2CapabilityTransport = {
    manifest: () => ({
      schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
      product: "Flyto2",
      runtime: "flyto-runtime",
      runtime_version: "1.1.4",
      runtime_id: "rt_0123456789abcdef0123456789abcdef",
      display_name: "test runtime",
      platform: "test",
      roles: ["executes_jobs"],
      capabilities: [{
        id: "source.read",
        revision: 1,
        risk_level: "low",
        approval: "none",
        evidence: ["file"],
      }],
    }),
    async invoke(invocation) {
      invocations.push(invocation);
      return {
        schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
        invocation_id: invocation.invocation_id,
        capability: invocation.capability,
        revision: invocation.revision,
        status: "success",
        started_at: "2026-09-30T00:00:00.000Z",
        completed_at: "2026-09-30T00:00:01.000Z",
        output: { content: "ok" },
        evidence: [],
      };
    },
  };
  const app = express();
  app.use(express.json());
  registerLocalCapabilityBridge(app, { stateDir }, transport);
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(stateDir, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}${LOCAL_CAPABILITY_BRIDGE_BASE_PATH}`;
  const tokenPath = localCapabilityBridgeTokenPath(stateDir);
  const token = (await readFile(tokenPath, "utf8")).trim();

  const unauthorized = await fetch(`${baseUrl}/manifest`);
  assert.equal(unauthorized.status, 401);

  const manifest = await fetch(`${baseUrl}/manifest`, {
    headers: { [LOCAL_CAPABILITY_BRIDGE_TOKEN_HEADER]: token },
  });
  assert.equal(manifest.status, 200);
  const manifestBody = await manifest.json() as { capabilities?: Array<{ id?: string }> };
  assert.deepEqual(manifestBody.capabilities?.map(({ id }) => id), ["source.read"]);

  const invocation = {
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    invocation_id: "bridge-invocation-1",
    capability: "source.read",
    revision: 1,
    operation_id: "bridge-operation-1",
    requested_at: "2026-09-30T00:00:00.000Z",
    input: { workspace_id: "ws_test", path: "README.md" },
  };
  const invoked = await fetch(`${baseUrl}/invoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [LOCAL_CAPABILITY_BRIDGE_TOKEN_HEADER]: token,
    },
    body: JSON.stringify(invocation),
  });
  assert.equal(invoked.status, 200);
  assert.equal((await invoked.json() as { status?: string }).status, "success");
  assert.equal(invocations.length, 1);

  const publicHost = await requestWithHost(
    `http://127.0.0.1:${address.port}${LOCAL_CAPABILITY_BRIDGE_BASE_PATH}/manifest`,
    "devspace.flyto2.com",
    token,
  );
  assert.equal(publicHost.status, 403);

  const invalid = await fetch(`${baseUrl}/invoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [LOCAL_CAPABILITY_BRIDGE_TOKEN_HEADER]: token,
    },
    body: JSON.stringify({ capability: "source.read" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invocations.length, 1);

  if (process.platform !== "win32") {
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  }
  assert.equal(ensureLocalCapabilityBridgeToken(stateDir), token);
});

async function requestWithHost(
  urlString: string,
  host: string,
  token: string,
): Promise<{ status: number }> {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: {
        host,
        [LOCAL_CAPABILITY_BRIDGE_TOKEN_HEADER]: token,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode ?? 0 }));
    });
    req.once("error", reject);
    req.end();
  });
}
