import type { ReviewCheckpointManager } from "../review-checkpoints.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { runtimeEventCapabilityAuditSink } from "./capability-audit.js";
import { runtimeCapabilityCatalog } from "./capability-catalog.js";
import { RuntimeCapabilityRegistry } from "./capability-provider.js";
import type { DurableOperationStore } from "./durable-operations.js";
import { registerExecutionRuntimeCapabilities } from "./execution-capabilities.js";
import { registerReadOnlyRuntimeCapabilities } from "./read-only-capabilities.js";
import type { ReactiveCommandRunner } from "./reactive-command.js";
import type { RuntimeEventStore } from "./runtime-events.js";

export interface CreateRuntimeCapabilityRegistryOptions {
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
  runtimeEvents: RuntimeEventStore;
  reactiveCommands?: ReactiveCommandRunner;
  durableOperations?: DurableOperationStore;
}

export function createRuntimeCapabilityRegistry(
  options: CreateRuntimeCapabilityRegistryOptions,
): RuntimeCapabilityRegistry {
  const registry = new RuntimeCapabilityRegistry(
    runtimeCapabilityCatalog(),
    runtimeEventCapabilityAuditSink(options.runtimeEvents),
  );
  registerReadOnlyRuntimeCapabilities(registry, options);
  if (options.reactiveCommands || options.durableOperations) {
    if (!options.reactiveCommands || !options.durableOperations) {
      throw new Error(
        "Runtime execution capabilities require both reactiveCommands and durableOperations.",
      );
    }
    registerExecutionRuntimeCapabilities(registry, {
      workspaces: options.workspaces,
      reactiveCommands: options.reactiveCommands,
      durableOperations: options.durableOperations,
    });
  }
  return registry;
}
