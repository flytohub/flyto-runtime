import * as z from "zod/v4";

export const hostTaskStatusSchema = z.enum(["active", "completed", "stopped"]);
export const taskExecutionStateSchema = z.enum([
  "waiting_for_host",
  "needs_attention",
  "completed",
  "stopped",
]);
export const taskDiagnosisStateSchema = z.enum([
  "active",
  "needs_attention",
  "completed",
  "stopped",
]);
export const processOperationalStateSchema = z.enum([
  "running",
  "completed",
  "failed",
  "orphaned",
]);
export const durableOperationStateSchema = z.enum(["running", "completed", "failed"]);
export const callbackDeliveryStateSchema = z.enum(["accepted", "gone", "rejected", "failed"]);

export const operationalReasonCodeSchema = z.enum([
  "TASK_COMPLETED",
  "TASK_STOPPED",
  "HOST_RESUME_REQUIRED",
  "PROCESS_RUNNING",
  "PROCESS_STALLED",
  "PROCESS_EXIT_NONZERO",
  "PROCESS_SIGNALLED",
  "PROCESS_ORPHANED",
  "PROCESS_COMPLETED",
  "EVENT_CALLBACK_FAILED",
  "EVENT_CALLBACK_REJECTED",
  "UNKNOWN",
]);

export const operationalPhaseSchema = z.enum([
  "host",
  "edit",
  "command",
  "test",
  "build",
  "ci_wait",
  "git",
  "agent",
  "callback_wait",
  "completed",
  "stopped",
  "unknown",
]);

export const operationalSuggestedActionSchema = z.enum([
  "continue_host_work",
  "inspect_existing_process",
  "resume_from_checkpoint",
  "inspect_callback_delivery",
  "none",
]);

export const operationalConfidenceSchema = z.enum(["high", "medium", "low"]);

export const operationalCorrelationSchema = z.object({
  task_id: z.string().optional(),
  workspace_id: z.string().optional(),
  process_session_id: z.string().optional(),
  operation_id: z.string().optional(),
  invocation_id: z.string().optional(),
  event_id: z.string().optional(),
});

export type HostTaskStatus = z.infer<typeof hostTaskStatusSchema>;
export type TaskExecutionState = z.infer<typeof taskExecutionStateSchema>;
export type TaskDiagnosisState = z.infer<typeof taskDiagnosisStateSchema>;
export type ProcessOperationalState = z.infer<typeof processOperationalStateSchema>;
export type DurableOperationOperationalState = z.infer<typeof durableOperationStateSchema>;
export type CallbackDeliveryState = z.infer<typeof callbackDeliveryStateSchema>;
export type OperationalReasonCode = z.infer<typeof operationalReasonCodeSchema>;
export type OperationalPhase = z.infer<typeof operationalPhaseSchema>;
export type OperationalSuggestedAction = z.infer<typeof operationalSuggestedActionSchema>;
export type OperationalConfidence = z.infer<typeof operationalConfidenceSchema>;
export type OperationalCorrelation = z.infer<typeof operationalCorrelationSchema>;

export interface TaskStateLike {
  status: HostTaskStatus;
  attentionReason?: string;
}

export interface ProcessStateLike {
  status: ProcessOperationalState;
  event_type?: string;
  suspected_stall?: boolean;
  exit_code?: number;
  signal?: string;
}

const HOST_TASK_STATUS_TRANSITIONS: Readonly<Record<HostTaskStatus, readonly HostTaskStatus[]>> = {
  active: ["completed", "stopped"],
  completed: [],
  stopped: [],
};

/** Canonical task execution projection used by recovery and tool surfaces. */
export function taskExecutionState(task: TaskStateLike): TaskExecutionState {
  if (task.status === "completed") return "completed";
  if (task.status === "stopped") return "stopped";
  if (task.attentionReason) return "needs_attention";
  return "waiting_for_host";
}

/** Canonical diagnosis state; unlike execution state, a healthy host-owned task is `active`. */
export function taskDiagnosisState(task: TaskStateLike): TaskDiagnosisState {
  const state = taskExecutionState(task);
  if (state === "waiting_for_host") return "active";
  return state;
}

export function canTransitionHostTaskStatus(
  from: HostTaskStatus,
  to: HostTaskStatus,
): boolean {
  return from === to || HOST_TASK_STATUS_TRANSITIONS[from].includes(to);
}

/** Stable diagnostic reason derived from durable process state. */
export function reasonCodeForProcess(
  process: ProcessStateLike | undefined,
): OperationalReasonCode {
  if (!process) return "UNKNOWN";
  if (process.status === "orphaned") return "PROCESS_ORPHANED";
  if (process.signal) return "PROCESS_SIGNALLED";
  if (process.status === "failed" && process.exit_code !== undefined && process.exit_code !== 0) {
    return "PROCESS_EXIT_NONZERO";
  }
  if (process.suspected_stall) return "PROCESS_STALLED";
  if (process.status === "completed") return "PROCESS_COMPLETED";
  if (process.status === "running") return "PROCESS_RUNNING";
  return "UNKNOWN";
}

/** Coarse product-facing phase derived from the command/event vocabulary. */
export function phaseForEventType(eventType: string | undefined): OperationalPhase {
  const value = (eventType ?? "").toLowerCase();
  if (!value) return "unknown";
  if (value.includes("callback") || value.startsWith("mcp.event.")) return "callback_wait";
  if (value.includes("test")) return "test";
  if (value.includes("build") || value.includes("package") || value.includes("schema")) return "build";
  if (value.includes("ci") || value.includes("workflow") || value.includes("gh.run") || value.includes("watch")) return "ci_wait";
  if (value.includes("git") || value.includes("commit") || value.includes("push")) return "git";
  if (value.includes("edit") || value.includes("patch") || value.includes("write")) return "edit";
  if (value.includes("agent")) return "agent";
  if (value.startsWith("task.completed")) return "completed";
  if (value.startsWith("task.stopped")) return "stopped";
  if (value.startsWith("task.")) return "host";
  if (value.startsWith("process.") || value.includes("exec") || value.includes("command")) return "command";
  return "unknown";
}

export function reasonCodeForEvent(
  type: string,
  payload: Record<string, unknown>,
): OperationalReasonCode | undefined {
  const declared = payload.reason_code;
  const parsed = operationalReasonCodeSchema.safeParse(declared);
  if (parsed.success) return parsed.data;
  switch (type) {
    case "process.started": return "PROCESS_RUNNING";
    case "process.stalled": return "PROCESS_STALLED";
    case "process.completed": return "PROCESS_COMPLETED";
    case "process.orphaned": return "PROCESS_ORPHANED";
    case "process.failed":
      return typeof payload.signal === "string" && payload.signal
        ? "PROCESS_SIGNALLED"
        : typeof payload.exit_code === "number" && payload.exit_code !== 0
          ? "PROCESS_EXIT_NONZERO"
          : "UNKNOWN";
    case "mcp.event.delivery_failed": return "EVENT_CALLBACK_FAILED";
    case "mcp.event.delivery_rejected": return "EVENT_CALLBACK_REJECTED";
    case "task.completed": return "TASK_COMPLETED";
    case "task.stopped": return "TASK_STOPPED";
    default: return undefined;
  }
}

/**
 * Canonical correlation projection for Runtime events. New event producers can
 * pass explicit correlations; old persisted events are reconstructed from the
 * established top-level and payload identifiers.
 */
export function operationalCorrelationFromEvent(input: {
  event_id: string;
  type: string;
  workspace_id?: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}): OperationalCorrelation {
  const taskId = stringValue(input.payload.task_id)
    ?? (input.correlation_id?.startsWith("task_") ? input.correlation_id : undefined);
  return compactCorrelation({
    task_id: taskId,
    workspace_id: stringValue(input.payload.workspace_id) ?? input.workspace_id,
    process_session_id: stringValue(input.payload.process_session_id),
    operation_id: stringValue(input.payload.operation_id),
    invocation_id: stringValue(input.payload.invocation_id)
      ?? (input.type.startsWith("capability.") ? input.correlation_id : undefined),
    event_id: input.event_id,
  });
}

export function mergeCorrelationsIntoPayload(
  payload: Record<string, unknown>,
  correlations: OperationalCorrelation | undefined,
): Record<string, unknown> {
  if (!correlations) return payload;
  const normalized = compactCorrelation(correlations);
  const { event_id: _eventId, ...persisted } = normalized;
  return { ...payload, ...persisted };
}

function compactCorrelation(input: OperationalCorrelation): OperationalCorrelation {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => typeof value === "string" && value.length > 0),
  ) as OperationalCorrelation;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
