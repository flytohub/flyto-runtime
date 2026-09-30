import type {
  RuntimeCapabilityAuditRecord,
  RuntimeCapabilityAuditSink,
} from "./capability-provider.js";
import type { RuntimeEventStore } from "./runtime-events.js";

export function runtimeEventCapabilityAuditSink(
  events: RuntimeEventStore,
): RuntimeCapabilityAuditSink {
  return {
    append(record) {
      events.append({
        type: record.type,
        source: "runtime-capability",
        workspace_id: record.workspace_id,
        correlation_id: record.invocation_id,
        summary: auditSummary(record),
        payload: compactPayload({
          invocation_id: record.invocation_id,
          capability: record.capability,
          revision: record.revision,
          operation_id: record.operation_id,
          trace_id: record.trace_id,
          duration_ms: record.duration_ms,
          operation_kind: record.operation?.kind,
          operation_ref: record.operation?.ref,
          operation_state: record.operation?.state,
          failure_code: record.failure?.code,
          retryable: record.failure?.retryable,
        }),
        evidence: record.evidence ?? [],
        occurred_at: record.occurred_at,
      });
    },
  };
}

function compactPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
}

function auditSummary(record: RuntimeCapabilityAuditRecord): string {
  switch (record.type) {
    case "capability.started":
      return `Runtime capability ${record.capability}@${record.revision} started.`;
    case "capability.accepted":
      return `Runtime capability ${record.capability}@${record.revision} accepted a durable operation.`;
    case "capability.completed":
      return `Runtime capability ${record.capability}@${record.revision} completed.`;
    case "capability.failed":
      return `Runtime capability ${record.capability}@${record.revision} failed.`;
  }
}
