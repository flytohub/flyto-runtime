import type { ReviewCheckpointManager } from "../review-checkpoints.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { runtimeEventCapabilityAuditSink } from "./capability-audit.js";
import { runtimeCapabilityCatalog } from "./capability-catalog.js";
import { RuntimeCapabilityRegistry } from "./capability-provider.js";
import { registerReadOnlyRuntimeCapabilities } from "./read-only-capabilities.js";
import type { RuntimeEventStore } from "./runtime-events.js";

export interface CreateRuntimeCapabilityRegistryOptions {
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
  runtimeEvents: RuntimeEventStore;
}

export function createRuntimeCapabilityRegistry(
  options: CreateRuntimeCapabilityRegistryOptions,
): RuntimeCapabilityRegistry {
  const registry = new RuntimeCapabilityRegistry(
    runtimeCapabilityCatalog(),
    runtimeEventCapabilityAuditSink(options.runtimeEvents),
  );
  registerReadOnlyRuntimeCapabilities(registry, options);
  return registry;
}
