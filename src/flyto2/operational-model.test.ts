import assert from "node:assert/strict";
import test from "node:test";
import {
  canTransitionHostTaskStatus,
  mergeCorrelationsIntoPayload,
  operationalCorrelationFromEvent,
  phaseForEventType,
  reasonCodeForEvent,
  reasonCodeForProcess,
  taskDiagnosisState,
  taskExecutionState,
} from "./operational-model.js";

test("operational model owns task state transitions and diagnosis projection", () => {
  assert.equal(taskExecutionState({ status: "active" }), "waiting_for_host");
  assert.equal(taskExecutionState({ status: "active", attentionReason: "failed" }), "needs_attention");
  assert.equal(taskDiagnosisState({ status: "active" }), "active");
  assert.equal(taskDiagnosisState({ status: "completed" }), "completed");
  assert.equal(canTransitionHostTaskStatus("active", "completed"), true);
  assert.equal(canTransitionHostTaskStatus("completed", "active"), false);
});

test("operational model centralizes process reasons and phases", () => {
  assert.equal(reasonCodeForProcess({ status: "running", suspected_stall: true }), "PROCESS_STALLED");
  assert.equal(reasonCodeForProcess({ status: "failed", exit_code: 2 }), "PROCESS_EXIT_NONZERO");
  assert.equal(reasonCodeForEvent("mcp.event.delivery_failed", {}), "EVENT_CALLBACK_FAILED");
  assert.equal(phaseForEventType("test.run"), "test");
  assert.equal(phaseForEventType("mcp.event.delivery_failed"), "callback_wait");
});

test("operational event correlations are additive and backward compatible", () => {
  const payload = mergeCorrelationsIntoPayload(
    { job_id: "job_abc" },
    { task_id: "task_abc", workspace_id: "ws_abc", process_session_id: "proc_abc" },
  );
  assert.deepEqual(payload, {
    job_id: "job_abc",
    task_id: "task_abc",
    workspace_id: "ws_abc",
    process_session_id: "proc_abc",
  });
  assert.deepEqual(operationalCorrelationFromEvent({
    event_id: "evt_abc",
    type: "task.process.completed",
    workspace_id: "ws_abc",
    correlation_id: "task_abc",
    payload,
  }), {
    task_id: "task_abc",
    workspace_id: "ws_abc",
    process_session_id: "proc_abc",
    event_id: "evt_abc",
  });
});
