import type { ReviewCheckpointManager } from "../review-checkpoints.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { runtimeEventCapabilityAuditSink } from "./capability-audit.js";
import { runtimeCapabilityCatalog } from "./capability-catalog.js";
import { RuntimeCapabilityRegistry } from "./capability-provider.js";
import type { DurableOperationStore } from "./durable-operations.js";
import { registerExecutionRuntimeCapabilities } from "./execution-capabilities.js";
import { registerMutationRuntimeCapabilities } from "./mutation-capabilities.js";
import { registerReadOnlyRuntimeCapabilities } from "./read-only-capabilities.js";
import type { ReactiveCommandRunner } from "./reactive-command.js";
import type { RuntimeEventStore } from "./runtime-events.js";

export interface CreateRuntimeCapabilityRegistryOptions {
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
  runtimeEvents: RuntimeEventStore;
  execution?: {
    reactiveCommands: ReactiveCommandRunner;
    durableOperations: DurableOperationStore;
  };
  mutation?: {
    durableOperations: DurableOperationStore;
  };
}

export function createRuntimeCapabilityRegistry(
  options: CreateRuntimeCapabilityRegistryOptions,
): RuntimeCapabilityRegistry {
  const registry = new RuntimeCapabilityRegistry(
    runtimeCapabilityCatalog(),
    runtimeEventCapabilityAuditSink(options.runtimeEvents),
  );
  registerReadOnlyRuntimeCapabilities(registry, options);
  if (options.execution) {
    registerExecutionRuntimeCapabilities(registry, {
      workspaces: options.workspaces,
      reactiveCommands: options.execution.reactiveCommands,
      durableOperations: options.execution.durableOperations,
    });
  }
  if (options.mutation) {
    registerMutationRuntimeCapabilities(registry, {
      workspaces: options.workspaces,
      reviewCheckpoints: options.reviewCheckpoints,
      durableOperations: options.mutation.durableOperations,
    });
  }
  return registry;
}
