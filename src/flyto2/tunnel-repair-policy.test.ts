import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideTunnelRepair,
  INITIAL_TUNNEL_REPAIR_STATE,
  TUNNEL_DNS_RECHECK_MS,
  TUNNEL_MAX_REPAIR_BACKOFF_MS,
} from "./tunnel-repair-policy.js";

test("offline DNS prevents tunnel restart loops and reports only transitions", () => {
  const first = decideTunnelRepair(INITIAL_TUNNEL_REPAIR_STATE, 100, true, false);
  assert.equal(first.action, "dns_unavailable");
  assert.equal(first.dnsTransition, "lost");
  assert.equal(first.state.attempts, 0);
  assert.equal(first.state.nextRetryAt, 100 + TUNNEL_DNS_RECHECK_MS);

  const waiting = decideTunnelRepair(first.state, 110, true, false);
  assert.equal(waiting.action, "wait");
  const next = decideTunnelRepair(first.state, first.state.nextRetryAt, true, false);
  assert.equal(next.action, "dns_unavailable");
  assert.equal(next.dnsTransition, undefined);
  assert.equal(next.state.attempts, 0);

  const recovered = decideTunnelRepair(next.state, next.state.nextRetryAt, true, true);
  assert.equal(recovered.action, "repair");
  assert.equal(recovered.dnsTransition, "restored");
  assert.equal(recovered.state.attempts, 1);
});

test("persistent connector failure backs off instead of restarting every 30 seconds", () => {
  let state = { ...INITIAL_TUNNEL_REPAIR_STATE };
  let now = 100;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const result = decideTunnelRepair(state, now, true);
    assert.equal(result.action, "repair");
    assert.equal(result.state.attempts, attempt);
    assert.ok(result.retryMs! <= TUNNEL_MAX_REPAIR_BACKOFF_MS);
    if (attempt >= 9) assert.equal(result.retryMs, TUNNEL_MAX_REPAIR_BACKOFF_MS);
    assert.equal(decideTunnelRepair(result.state, now + 1, true).action, "wait");
    state = result.state;
    now = result.state.nextRetryAt;
  }
});

test("healthy redundant connectors clear prior DNS and retry state", () => {
  const degraded = decideTunnelRepair(INITIAL_TUNNEL_REPAIR_STATE, 100, true, false);
  const healthy = decideTunnelRepair(degraded.state, 101, false);
  assert.equal(healthy.action, "healthy");
  assert.equal(healthy.dnsTransition, "restored");
  assert.deepEqual(healthy.state, INITIAL_TUNNEL_REPAIR_STATE);
  assert.equal(decideTunnelRepair(healthy.state, 102, true).state.attempts, 1);
});
