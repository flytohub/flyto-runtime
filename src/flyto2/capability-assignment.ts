import { createHash } from "node:crypto";
import type { Flyto2Completion } from "./cloud-bridge.js";
import type {
  Flyto2AssignmentExecutionContext,
  Flyto2AssignmentExecutor,
} from "./connected-runtime.js";
import type { Flyto2CapabilityTransport } from "./capability-transport.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  flyto2CapabilityInvocationSchema,
  type Flyto2Assignment,
  type Flyto2CapabilityFollowUp,
  type Flyto2CapabilityInvocation,
  type Flyto2CapabilityResult,
} from "./protocol.js";

const MAX_ACCEPTED_WAIT_CYCLES = 10_000;

export class Flyto2CapabilityAssignmentExecutor implements Flyto2AssignmentExecutor {
  constructor(private readonly transport: Flyto2CapabilityTransport) {}

  async execute(
    assignment: Flyto2Assignment,
    context: Flyto2AssignmentExecutionContext,
  ): Promise<Flyto2Completion> {
    if (assignment.kind !== "capability") {
      return failureCompletion(
        "unsupported_assignment_kind",
        undefined,
        `Capability executor cannot run assignment kind ${assignment.kind}.`,
      );
    }

    let invocation: Flyto2CapabilityInvocation;
    try {
      invocation = capabilityInvocationFromAssignment(assignment);
    } catch (error) {
      return failureCompletion(
        "invalid_capability_invocation",
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }

    const available = this.transport.manifest().capabilities.some(
      ({ id, revision }) => id === invocation.capability && revision === invocation.revision,
    );
    if (!available) {
      return failureCompletion(
        "capability_unavailable",
        invocation.capability,
        `Runtime does not expose ${invocation.capability}@${invocation.revision}.`,
      );
    }

    let result = await this.transport.invoke(invocation, context.signal);
    let waitCycle = 0;
    while (result.status === "accepted") {
      if (context.signal?.aborted) {
        return failureCompletion(
          "assignment_cancelled",
          invocation.capability,
          "Capability assignment was cancelled before completion.",
        );
      }
      if (waitCycle >= MAX_ACCEPTED_WAIT_CYCLES) {
        return failureCompletion(
          "capability_wait_limit",
          invocation.capability,
          "Capability operation exceeded the maximum number of bounded event waits.",
        );
      }
      const wait = result.operation?.wait;
      if (!wait) {
        return failureCompletion(
          "capability_operation_unresolvable",
          invocation.capability,
          "Accepted capability result did not provide a wait follow-up.",
        );
      }

      const progress = await context.reportProgress({
        status: "running",
        step_result: {
          capability: invocation.capability,
          operation_kind: result.operation?.kind,
          operation_ref: result.operation?.ref,
          wait_cycle: waitCycle,
        },
      });
      if (progress.cancel_requested) {
        return failureCompletion(
          "assignment_cancelled",
          invocation.capability,
          "Flyto2 Cloud requested cancellation.",
        );
      }

      const waited = await this.transport.invoke(
        followUpInvocation(invocation, wait, waitCycle),
        context.signal,
      );
      if (waited.status === "failed") return completionFromResult(waited);
      if (waited.status === "accepted") {
        // A bounded observer may itself remain accepted while the underlying
        // operation is still running (for example agent.wait). Follow the
        // returned operation handle instead of treating that as an error.
        result = waited;
        waitCycle += 1;
        continue;
      }
      if (waited.output.matched === false) {
        waitCycle += 1;
        continue;
      }

      // Replaying the original operation_id is intentional. Side-effecting
      // providers reuse DurableOperationStore and therefore inspect the
      // original durable operation instead of starting it again. Wait
      // capabilities that do not expose a `matched` flag are terminal once
      // they return success, so the original operation can be reconciled too.
      result = await this.transport.invoke(invocation, context.signal);
      waitCycle += 1;
    }
    return completionFromResult(result);
  }
}

export function capabilityInvocationFromAssignment(
  assignment: Flyto2Assignment,
): Flyto2CapabilityInvocation {
  if (assignment.kind !== "capability") {
    throw new Error(`Assignment ${assignment.assignment_id} is not a capability assignment.`);
  }
  const raw = recordField(assignment.payload, "capability_invocation")
    ?? recordField(assignment.payload, "invocation");
  if (!raw) throw new Error("Capability assignment is missing capability_invocation.");
  return flyto2CapabilityInvocationSchema.parse({
    ...raw,
    schema: raw.schema ?? FLYTO2_EXECUTION_PROTOCOL_VERSION,
    trace_id: raw.trace_id ?? assignment.trace_id,
  });
}

function followUpInvocation(
  original: Flyto2CapabilityInvocation,
  followUp: Flyto2CapabilityFollowUp,
  cycle: number,
): Flyto2CapabilityInvocation {
  const digest = createHash("sha256")
    .update(`${original.invocation_id}\0${original.operation_id}\0${followUp.capability}\0${cycle}`)
    .digest("hex")
    .slice(0, 32);
  return flyto2CapabilityInvocationSchema.parse({
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    invocation_id: `followup-${digest}`,
    capability: followUp.capability,
    revision: 1,
    operation_id: `followup-${digest}`,
    trace_id: original.trace_id,
    requested_at: new Date().toISOString(),
    input: followUp.input,
  });
}

function completionFromResult(result: Flyto2CapabilityResult): Flyto2Completion {
  if (result.status === "success") {
    return {
      status: "success",
      variables: { capability_result: result },
    };
  }
  if (result.status === "accepted") {
    return failureCompletion(
      "capability_operation_unresolved",
      result.capability,
      "Capability operation is still accepted rather than terminal.",
    );
  }
  return {
    status: "failed",
    error_message: result.failure?.detail ?? result.failure?.code ?? "Capability failed.",
    variables: { capability_result: result },
    failure: {
      code: result.failure?.code ?? "capability_failed",
      capability: result.capability,
      retryable_elsewhere: result.failure?.retryable ?? false,
      detail: result.failure?.detail,
    },
  };
}

function failureCompletion(
  code: string,
  capability: string | undefined,
  detail: string,
): Flyto2Completion {
  return {
    status: "failed",
    error_message: detail,
    failure: {
      code,
      capability,
      retryable_elsewhere: false,
      detail,
    },
  };
}

function recordField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const field = value[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? field as Record<string, unknown>
    : undefined;
}
