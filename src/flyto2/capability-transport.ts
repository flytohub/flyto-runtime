import type { ServerConfig } from "../config.js";
import type { RuntimeCapabilityRegistry } from "./capability-provider.js";
import { runtimeManifest } from "./manifest.js";
import type {
  Flyto2CapabilityInvocation,
  Flyto2CapabilityResult,
  Flyto2RuntimeManifest,
} from "./protocol.js";

export interface Flyto2CapabilityTransport {
  manifest(): Flyto2RuntimeManifest;
  invoke(
    invocation: Flyto2CapabilityInvocation,
    signal?: AbortSignal,
  ): Promise<Flyto2CapabilityResult>;
}

export function registryCapabilityTransport(
  config: ServerConfig,
  registry: RuntimeCapabilityRegistry,
): Flyto2CapabilityTransport {
  return {
    manifest() {
      return runtimeManifest(config, registry.registeredCapabilities());
    },
    invoke(invocation, signal) {
      return registry.execute(invocation, signal);
    },
  };
}
