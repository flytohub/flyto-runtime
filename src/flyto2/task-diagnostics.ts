import * as z from "zod/v4";
import type { HostTaskRecord } from "./host-tasks.js";
import {
  reactiveJobSessionId,
  type ReactiveCommandRunner,
  type ReactiveJobRecord,
} from "./reactive-command.js";
import type { RuntimeEvent, RuntimeEventStore } from "./runtime-events.js";
import {
  operationalConfidenceSchema,
  operationalPhaseSchema,
  operationalReasonCodeSchema,
  operationalSuggestedActionSchema,
  phaseForEventType,
  reasonCodeForEvent,
  reasonCodeForProcess,
  taskDiagnosisState,
} from "./operational-model.js";

const MAX_TIMELINE_EVENTS = 24;
const MAX_WORKSPACE_EVENTS = 120;

export const taskDiagnosticReasonCodeSchema = operationalReasonCodeSchema;
export const taskDiagnosticPhaseSchema = operationalPhaseSchema;

export const taskTimelineEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  event_id: z.string(),
  occurred_at: z.string(),
  type: z.string(),
  phase: taskDiagnosticPhaseSchema,
  summary: z.string(),
  reason_code: taskDiagnosticReasonCodeSchema.optional(),
  process_session_id: z.string().optional(),
  operation_id: z.string().optional(),
  invocation_id: z.string().optional(),
  exit_code: z.number().int().optional(),
});

export const taskDiagnosisSchema = z.object({
  state: z.enum(["active", "needs_attention", "completed", "stopped"]),
  phase: taskDiagnosticPhaseSchema,
  reason_code: taskDiagnosticReasonCodeSchema,
  confidence: operationalConfidenceSchema,
  summary: z.string(),
  suggested_action: operationalSuggestedActionSchema,
  current_process: z.object({
    session_id: z.string(),
    status: z.enum(["running", "completed", "failed", "orphaned"]),
    event_type: z.string(),
    elapsed_ms: z.number().int().nonnegative(),
    evidence_bytes: z.number().int().nonnegative(),
    last_activity_at: z.string(),
    idle_ms: z.number().int().nonnegative(),
    suspected_stall: z.boolean(),
    exit_code: z.number().int().optional(),
    signal: z.string().optional(),
  }).optional(),
  correlations: z.object({
    task_id: z.string(),
    workspace_id: z.string(),
    event_ids: z.array(z.string()),
    process_session_ids: z.array(z.string()),
    operation_ids: z.array(z.string()),
    invocation_ids: z.array(z.string()),
  }),
  timeline: z.array(taskTimelineEntrySchema),
});

export type TaskDiagnosis = z.infer<typeof taskDiagnosisSchema>;
export type TaskDiagnosticReasonCode = z.infer<typeof taskDiagnosticReasonCodeSchema>;
export type TaskDiagnosticPhase = z.infer<typeof taskDiagnosticPhaseSchema>;

/** Builds a bounded, secret-free diagnosis projection from durable Runtime state. */
export function buildTaskDiagnosis(
  task: HostTaskRecord,
  reactiveCommands: ReactiveCommandRunner,
  runtimeEvents: RuntimeEventStore,
): TaskDiagnosis {
  const events = relevantEvents(task, runtimeEvents);
  const currentProcess = relevantProcess(reactiveCommands, events);
  const timeline = events
    .map(taskTimelineEntry)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .slice(-MAX_TIMELINE_EVENTS);
  const callbackFailure = [...timeline].reverse().find((entry) =>
    entry.reason_code === "EVENT_CALLBACK_FAILED"
      || entry.reason_code === "EVENT_CALLBACK_REJECTED");
  const state = diagnosticState(task);
  const diagnosis = diagnose(task, currentProcess, callbackFailure);

  return {
    state,
    ...diagnosis,
    current_process: currentProcess ? processProjection(currentProcess) : undefined,
    correlations: correlationProjection(task, events),
    timeline,
  };
}

function relevantProcess(
  reactiveCommands: ReactiveCommandRunner,
  events: RuntimeEvent[],
): ReactiveJobRecord | undefined {
  const mappedJobId = [...events].reverse()
    .map((event) => stringPayload(event, "job_id"))
    .find((value): value is string => Boolean(value));
  return mappedJobId ? reactiveCommands.get(mappedJobId) : undefined;
}

function relevantEvents(task: HostTaskRecord, runtimeEvents: RuntimeEventStore): RuntimeEvent[] {
  const byTask = runtimeEvents.listRecent({ correlation_id: task.id, limit: MAX_WORKSPACE_EVENTS });
  const jobIds = new Set(
    byTask
      .map((event) => stringPayload(event, "job_id"))
      .filter((value): value is string => Boolean(value)),
  );
  const merged = new Map<string, RuntimeEvent>();
  for (const event of byTask) merged.set(event.event_id, event);
  for (const jobId of jobIds) {
    for (const event of runtimeEvents.listRecent({ correlation_id: jobId, limit: 60 })) {
      if (Date.parse(event.occurred_at) < Date.parse(task.createdAt)) continue;
      merged.set(event.event_id, event);
    }
  }
  return [...merged.values()].sort((a, b) => a.sequence - b.sequence);
}

function taskTimelineEntry(event: RuntimeEvent) {
  if (!isDiagnosticEvent(event.type)) return undefined;
  const jobId = stringPayload(event, "job_id")
    ?? (event.type.startsWith("process.") ? event.correlation_id : undefined);
  return {
    sequence: event.sequence,
    event_id: event.event_id,
    occurred_at: event.occurred_at,
    type: event.type,
    phase: phaseForEvent(event),
    summary: event.summary,
    reason_code: reasonForEvent(event),
    process_session_id: event.correlations?.process_session_id
      ?? (jobId ? safeProcessSession(jobId) : undefined),
    operation_id: event.correlations?.operation_id ?? stringPayload(event, "operation_id"),
    invocation_id: event.correlations?.invocation_id ?? stringPayload(event, "invocation_id")
      ?? (event.type.startsWith("capability.") ? event.correlation_id : undefined),
    exit_code: numberPayload(event, "exit_code"),
  };
}

function diagnose(
  task: HostTaskRecord,
  process: ReactiveJobRecord | undefined,
  callbackFailure: z.infer<typeof taskTimelineEntrySchema> | undefined,
): Pick<TaskDiagnosis, "phase" | "reason_code" | "confidence" | "summary" | "suggested_action"> {
  if (task.status === "completed") {
    return {
      phase: "completed",
      reason_code: "TASK_COMPLETED",
      confidence: "high",
      summary: "The durable task completed normally.",
      suggested_action: "none",
    };
  }
  if (task.status === "stopped") {
    return {
      phase: "stopped",
      reason_code: "TASK_STOPPED",
      confidence: "high",
      summary: "The durable task was stopped.",
      suggested_action: "none",
    };
  }
  if (task.attentionReason) {
    const reason = processReason(process);
    return {
      phase: process ? phaseForProcess(process) : "host",
      reason_code: reason,
      confidence: process ? "high" : "medium",
      summary: task.attentionReason,
      suggested_action: "resume_from_checkpoint",
    };
  }
  if (process?.status === "running") {
    return process.suspected_stall
      ? {
          phase: phaseForProcess(process),
          reason_code: "PROCESS_STALLED",
          confidence: "high",
          summary: `The process is alive but has produced no observed progress for ${Math.round(process.idle_ms / 1_000)} seconds.`,
          suggested_action: "inspect_existing_process",
        }
      : {
          phase: phaseForProcess(process),
          reason_code: "PROCESS_RUNNING",
          confidence: "high",
          summary: "The process is still alive and Runtime is observing progress state.",
          suggested_action: "inspect_existing_process",
        };
  }
  if (callbackFailure && process?.status === "completed") {
    return {
      phase: "callback_wait",
      reason_code: callbackFailure.reason_code ?? "EVENT_CALLBACK_FAILED",
      confidence: "high",
      summary: "The process completed, but MCP event delivery did not complete successfully.",
      suggested_action: "inspect_callback_delivery",
    };
  }
  if (process?.status === "completed") {
    return {
      phase: phaseForProcess(process),
      reason_code: "PROCESS_COMPLETED",
      confidence: "medium",
      summary: "The latest process completed; ChatGPT still owns the remaining task continuation.",
      suggested_action: "continue_host_work",
    };
  }
  return {
    phase: "host",
    reason_code: "HOST_RESUME_REQUIRED",
    confidence: "medium",
    summary: "No active Runtime process owns the next step; ChatGPT should resume from the persisted task state.",
    suggested_action: "continue_host_work",
  };
}

function diagnosticState(task: HostTaskRecord): TaskDiagnosis["state"] {
  return taskDiagnosisState(task);
}

function processProjection(process: ReactiveJobRecord) {
  return {
    session_id: reactiveJobSessionId(process.job_id),
    status: process.status,
    event_type: process.event_type,
    elapsed_ms: process.elapsed_ms,
    evidence_bytes: process.evidence_bytes,
    last_activity_at: process.last_activity_at,
    idle_ms: process.idle_ms,
    suspected_stall: process.suspected_stall,
    exit_code: process.exit_code,
    signal: process.signal,
  };
}

function correlationProjection(task: HostTaskRecord, events: RuntimeEvent[]) {
  const processSessionIds = new Set<string>();
  const operationIds = new Set<string>();
  const invocationIds = new Set<string>();
  for (const event of events) {
    const explicitProcessSession = event.correlations?.process_session_id;
    if (explicitProcessSession) processSessionIds.add(explicitProcessSession);
    else {
      const jobId = stringPayload(event, "job_id")
        ?? (event.type.startsWith("process.") ? event.correlation_id : undefined);
      if (jobId) {
        const session = safeProcessSession(jobId);
        if (session) processSessionIds.add(session);
      }
    }
    const operationId = event.correlations?.operation_id ?? stringPayload(event, "operation_id");
    if (operationId) operationIds.add(operationId);
    const invocationId = event.correlations?.invocation_id ?? stringPayload(event, "invocation_id")
      ?? (event.type.startsWith("capability.") ? event.correlation_id : undefined);
    if (invocationId) invocationIds.add(invocationId);
  }
  return {
    task_id: task.id,
    workspace_id: task.workspaceId,
    event_ids: events.slice(-MAX_TIMELINE_EVENTS).map((event) => event.event_id),
    process_session_ids: [...processSessionIds],
    operation_ids: [...operationIds],
    invocation_ids: [...invocationIds],
  };
}

function phaseForProcess(process: ReactiveJobRecord): TaskDiagnosticPhase {
  return phaseForEventType(process.event_type);
}

function phaseForEvent(event: RuntimeEvent): TaskDiagnosticPhase {
  const capability = stringPayload(event, "capability");
  const eventType = stringPayload(event, "event_type");
  return phaseForEventType(capability ?? eventType ?? event.type);
}

function processReason(process: ReactiveJobRecord | undefined): TaskDiagnosticReasonCode {
  return reasonCodeForProcess(process);
}

function reasonForEvent(event: RuntimeEvent): TaskDiagnosticReasonCode | undefined {
  return reasonCodeForEvent(event.type, event.payload);
}

function isDiagnosticEvent(type: string): boolean {
  return type.startsWith("task.")
    || type.startsWith("process.")
    || type.startsWith("capability.")
    || type.startsWith("mcp.event.");
}

function stringPayload(event: RuntimeEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" && value ? value : undefined;
}

function numberPayload(event: RuntimeEvent, key: string): number | undefined {
  const value = event.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeProcessSession(jobId: string): string | undefined {
  try {
    return reactiveJobSessionId(jobId);
  } catch {
    return undefined;
  }
}
