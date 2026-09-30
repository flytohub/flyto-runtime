export const RUNTIME_CAPABILITY_BUNDLE_IDS = [
  "read",
  "execution",
  "mutation",
  "observability",
  "agent",
] as const;

export type RuntimeCapabilityBundleId =
  typeof RUNTIME_CAPABILITY_BUNDLE_IDS[number];

/** A named set of Runtime-local provider bundles selected by one composition. */
export interface RuntimeCapabilityProfile {
  id: string;
  bundles: readonly RuntimeCapabilityBundleId[];
}

/** Core standalone Runtime profile; optional agent delegation is added separately. */
export const STANDALONE_RUNTIME_CAPABILITY_PROFILE: RuntimeCapabilityProfile = {
  id: "standalone",
  bundles: ["read", "execution", "mutation", "observability"],
};

/** Minimal profile for consumers that only need non-mutating repository access. */
export const READ_ONLY_RUNTIME_CAPABILITY_PROFILE: RuntimeCapabilityProfile = {
  id: "read-only",
  bundles: ["read"],
};

/** Builds a deduplicated custom capability profile without changing the wire contract. */
export function runtimeCapabilityProfile(
  id: string,
  bundles: readonly RuntimeCapabilityBundleId[],
): RuntimeCapabilityProfile {
  const unique = [...new Set(bundles)];
  return { id, bundles: unique };
}

/** Builds the standalone profile and optionally attaches the local-agent bundle. */
export function standaloneRuntimeCapabilityProfile(
  options: { agent?: boolean } = {},
): RuntimeCapabilityProfile {
  return runtimeCapabilityProfile(
    "standalone",
    options.agent
      ? [...STANDALONE_RUNTIME_CAPABILITY_PROFILE.bundles, "agent"]
      : STANDALONE_RUNTIME_CAPABILITY_PROFILE.bundles,
  );
}
