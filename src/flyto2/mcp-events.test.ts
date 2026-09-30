import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpEventService, type McpEventWebhookPost } from "./mcp-events.js";
import { RuntimeEventStore } from "./runtime-events.js";

test("MCP Events subscription verifies, persists, filters, and signs Runtime deliveries", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-mcp-events-"));
  const runtimeEvents = new RuntimeEventStore(stateDir);
  const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
  let resolveDelivery!: (value: { body: string; headers: Record<string, string> }) => void;
  const delivered = new Promise<{ body: string; headers: Record<string, string> }>((resolve) => {
    resolveDelivery = resolve;
  });
  const webhookPost: McpEventWebhookPost = async (_url, body, headers) => {
    const parsed = JSON.parse(body) as { type?: string; challenge?: string; name?: string };
    if (parsed.type === "verification") {
      return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
    }
    resolveDelivery({ body, headers });
    return { status: 202, body: "ok" };
  };
  const service = new McpEventService(stateDir, runtimeEvents, webhookPost);
  t.after(async () => {
    service.close();
    runtimeEvents.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const discover = await service.handle({ id: 1, method: "server/discover" }, "client:test");
  assert.deepEqual((discover?.result as { supportedVersions?: string[] }).supportedVersions, ["2026-07-28"]);

  const subscribe = await service.handle({
    id: 2,
    method: "events/subscribe",
    params: {
      name: "process.failed",
      arguments: { workspace_id: "ws-1" },
      delivery: {
        mode: "webhook",
        url: "https://callback.example.test/mcp-events/abc",
        secret,
      },
    },
  }, "client:test");
  assert.ok((subscribe?.result as { id?: string }).id?.startsWith("sub_"));

  const unsafe = await service.handle({
    id: 22,
    method: "events/subscribe",
    params: {
      name: "process.failed",
      arguments: {},
      delivery: {
        mode: "webhook",
        url: "http://127.0.0.1/callback",
        secret,
      },
    },
  }, "client:test");
  assert.equal(unsafe?.error?.code, -32015);
  assert.equal(unsafe?.error?.data?.reason, "https_required");

  runtimeEvents.append({
    type: "process.failed",
    source: "reactive-runner",
    workspace_id: "ws-other",
    correlation_id: "job_other",
    summary: "Filtered failure.",
  });
  runtimeEvents.append({
    event_id: "evt_test_delivery",
    type: "process.failed",
    source: "reactive-runner",
    workspace_id: "ws-1",
    correlation_id: "job_1",
    summary: "Build failed.",
    payload: { exit_code: 1 },
    occurred_at: "2026-09-30T12:00:00.000Z",
  });

  const delivery = await Promise.race([
    delivered,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("event delivery timed out")), 2_000)),
  ]);
  const event = JSON.parse(delivery.body) as { eventId: string; name: string; data: { workspace_id?: string } };
  assert.equal(event.eventId, "evt_test_delivery");
  assert.equal(event.name, "process.failed");
  assert.equal(event.data.workspace_id, "ws-1");
  assert.match(delivery.headers["webhook-signature"] ?? "", /^v1,/);

  const timestamp = delivery.headers["webhook-timestamp"]!;
  const expected = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`evt_test_delivery.${timestamp}.${delivery.body}`)
    .digest("base64");
  assert.equal(delivery.headers["webhook-signature"], `v1,${expected}`);

  const unsubscribe = await service.handle({
    id: 3,
    method: "events/unsubscribe",
    params: {
      name: "process.failed",
      arguments: { workspace_id: "ws-1" },
      delivery: { mode: "webhook", url: "https://callback.example.test/mcp-events/abc" },
    },
  }, "client:test");
  assert.deepEqual(unsubscribe?.result, {});
});

test("MCP Events subscriptions survive service restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-mcp-events-restart-"));
  const runtimeEvents = new RuntimeEventStore(stateDir);
  const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  let delivered = 0;
  const webhookPost: McpEventWebhookPost = async (_url, body) => {
    const parsed = JSON.parse(body) as { type?: string; challenge?: string };
    if (parsed.type === "verification") {
      return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
    }
    delivered += 1;
    return { status: 200, body: "ok" };
  };
  let service = new McpEventService(stateDir, runtimeEvents, webhookPost);
  t.after(async () => {
    service.close();
    runtimeEvents.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const subscribed = await service.handle({
    id: 1,
    method: "events/subscribe",
    params: {
      name: "task.needs_attention",
      arguments: {},
      delivery: {
        mode: "webhook",
        url: "https://callback.example.test/restart",
        secret,
      },
    },
  }, "client:restart");
  assert.ok((subscribed?.result as { id?: string }).id);
  service.close();
  service = new McpEventService(stateDir, runtimeEvents, webhookPost);

  runtimeEvents.append({
    type: "task.needs_attention",
    source: "task-process-closure",
    workspace_id: "ws_restart",
    correlation_id: "task_restart",
    summary: "Task requires attention.",
  });
  for (let attempt = 0; attempt < 50 && delivered === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(delivered, 1);
});

test("MCP Events records callback rejection without leaking delivery secrets", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-mcp-events-diagnostics-"));
  const runtimeEvents = new RuntimeEventStore(stateDir);
  const secret = `whsec_${Buffer.alloc(32, 5).toString("base64")}`;
  const webhookPost: McpEventWebhookPost = async (_url, body) => {
    const parsed = JSON.parse(body) as { type?: string; challenge?: string };
    if (parsed.type === "verification") {
      return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
    }
    return { status: 400, body: "rejected" };
  };
  const service = new McpEventService(stateDir, runtimeEvents, webhookPost);
  t.after(async () => {
    service.close();
    runtimeEvents.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  await service.handle({
    id: 1,
    method: "events/subscribe",
    params: {
      name: "process.failed",
      arguments: { workspace_id: "ws-diag" },
      delivery: {
        mode: "webhook",
        url: "https://callback.example.test/diag",
        secret,
      },
    },
  }, "client:diag");
  const cursor = runtimeEvents.latestSequence();
  runtimeEvents.append({
    type: "process.failed",
    source: "reactive-runner",
    workspace_id: "ws-diag",
    correlation_id: "job_diag",
    summary: "Process failed.",
  });
  const diagnostic = await runtimeEvents.wait({
    after_sequence: cursor,
    type: "mcp.event.delivery_rejected",
    correlation_id: "job_diag",
    timeout_ms: 2_000,
  });
  assert.equal(diagnostic?.payload.outcome, "rejected");
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /callback\.example\.test/);
  assert.doesNotMatch(serialized, /whsec_/);
});
