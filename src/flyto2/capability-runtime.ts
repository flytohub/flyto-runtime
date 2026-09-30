import type { ReviewCheckpointManager } from "../review-checkpoints.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { runtimeEventCapabilityAuditSink } from "./capability-audit.js";
import {
  STANDALONE_RUNTIME_CAPABILITY_PROFILE,
  type RuntimeCapabilityBundleId,
  type RuntimeCapabilityProfile,
} from "./capability-bundles.js";
import { runtimeCapabilityCatalog } from "./capability-catalog.js";
import { RuntimeCapabilityRegistry } from "./capability-provider.js";
import type { DurableOperationStore } from "./durable-operations.js";
import { registerExecutionRuntimeCapabilities } from "./execution-capabilities.js";
import { registerMutationRuntimeCapabilities } from "./mutation-capabilities.js";
import { registerObservabilityRuntimeCapabilities } from "./observability-capabilities.js";
import { registerReadOnlyRuntimeCapabilities } from "./read-only-capabilities.js";
import type { ReactiveCommandRunner } from "./reactive-command.js";
import type { RuntimeEventStore } from "./runtime-events.js";

export interface CreateRuntimeCapabilityRegistryOptions {
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
  runtimeEvents: RuntimeEventStore;
  profile?: RuntimeCapabilityProfile;
  execution?: {
    reactiveCommands: ReactiveCommandRunner;
    durableOperations: DurableOperationStore;
  };
  mutation?: {
    durableOperations: DurableOperationStore;
  };
  observability?: {
    reactiveCommands: ReactiveCommandRunner;
  };
}

export function createRuntimeCapabilityRegistry(
  options: CreateRuntimeCapabilityRegistryOptions,
): RuntimeCapabilityRegistry {
  const registry = new RuntimeCapabilityRegistry(
    runtimeCapabilityCatalog(),
    runtimeEventCapabilityAuditSink(options.runtimeEvents),
  );
  const bundles = selectedBundles(options);
  if (bundles.has("read")) {
    registerReadOnlyRuntimeCapabilities(registry, options);
  }
  if (bundles.has("execution")) {
    if (!options.execution) {
      throw missingBundleDependency("execution");
    }
    registerExecutionRuntimeCapabilities(registry, {
      workspaces: options.workspaces,
      reactiveCommands: options.execution.reactiveCommands,
      durableOperations: options.execution.durableOperations,
    });
  }
  if (bundles.has("mutation")) {
    if (!options.mutation) {
      throw missingBundleDependency("mutation");
    }
    registerMutationRuntimeCapabilities(registry, {
      workspaces: options.workspaces,
      reviewCheckpoints: options.reviewCheckpoints,
      durableOperations: options.mutation.durableOperations,
    });
  }
  if (bundles.has("observability")) {
    if (!options.observability) {
      throw missingBundleDependency("observability");
    }
    registerObservabilityRuntimeCapabilities(registry, {
      workspaces: options.workspaces,
      runtimeEvents: options.runtimeEvents,
      reactiveCommands: options.observability.reactiveCommands,
    });
  }
  return registry;
}

export interface CreateStandaloneRuntimeCapabilityRegistryOptions
  extends Omit<CreateRuntimeCapabilityRegistryOptions, "profile" | "execution" | "mutation" | "observability"> {
  execution: NonNullable<CreateRuntimeCapabilityRegistryOptions["execution"]>;
  mutation: NonNullable<CreateRuntimeCapabilityRegistryOptions["mutation"]>;
  observability: NonNullable<CreateRuntimeCapabilityRegistryOptions["observability"]>;
}

export function createStandaloneRuntimeCapabilityRegistry(
  options: CreateStandaloneRuntimeCapabilityRegistryOptions,
): RuntimeCapabilityRegistry {
  return createRuntimeCapabilityRegistry({
    ...options,
    profile: STANDALONE_RUNTIME_CAPABILITY_PROFILE,
  });
}

function selectedBundles(
  options: CreateRuntimeCapabilityRegistryOptions,
): ReadonlySet<RuntimeCapabilityBundleId> {
  if (options.profile) return new Set(options.profile.bundles);
  const bundles: RuntimeCapabilityBundleId[] = ["read"];
  if (options.execution) bundles.push("execution");
  if (options.mutation) bundles.push("mutation");
  if (options.observability) bundles.push("observability");
  return new Set(bundles);
}

function missingBundleDependency(bundle: RuntimeCapabilityBundleId): Error {
  return new Error(`Runtime capability bundle ${bundle} was selected without its required dependencies.`);
}
