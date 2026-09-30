import type { ReviewCheckpointManager } from "../review-checkpoints.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import type { LocalAgentClient } from "../local-agent-client.js";
import { registerAgentRuntimeCapabilities } from "./agent-capabilities.js";
import { runtimeEventCapabilityAuditSink } from "./capability-audit.js";
import {
  standaloneRuntimeCapabilityProfile,
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
  agent?: {
    client: Pick<LocalAgentClient, "start" | "continue" | "get" | "wait">;
    durableOperations: DurableOperationStore;
  };
}

/**
 * Composes a Runtime capability registry from explicitly selected provider
 * bundles. With no profile it preserves the legacy dependency-driven selection.
 */
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
  if (bundles.has("agent")) {
    if (!options.agent) {
      throw missingBundleDependency("agent");
    }
    registerAgentRuntimeCapabilities(registry, {
      workspaces: options.workspaces,
      client: options.agent.client,
      durableOperations: options.agent.durableOperations,
    });
  }
  return registry;
}

export interface CreateStandaloneRuntimeCapabilityRegistryOptions
  extends Omit<CreateRuntimeCapabilityRegistryOptions, "profile" | "execution" | "mutation" | "observability" | "agent"> {
  execution: NonNullable<CreateRuntimeCapabilityRegistryOptions["execution"]>;
  mutation: NonNullable<CreateRuntimeCapabilityRegistryOptions["mutation"]>;
  observability: NonNullable<CreateRuntimeCapabilityRegistryOptions["observability"]>;
  agent?: NonNullable<CreateRuntimeCapabilityRegistryOptions["agent"]>;
}

/** Creates the standalone registry, enabling agent delegation only when supplied. */
export function createStandaloneRuntimeCapabilityRegistry(
  options: CreateStandaloneRuntimeCapabilityRegistryOptions,
): RuntimeCapabilityRegistry {
  return createRuntimeCapabilityRegistry({
    ...options,
    profile: standaloneRuntimeCapabilityProfile({ agent: Boolean(options.agent) }),
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
  if (options.agent) bundles.push("agent");
  return new Set(bundles);
}

function missingBundleDependency(bundle: RuntimeCapabilityBundleId): Error {
  return new Error(`Runtime capability bundle ${bundle} was selected without its required dependencies.`);
}
