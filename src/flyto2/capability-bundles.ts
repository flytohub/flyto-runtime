export const RUNTIME_CAPABILITY_BUNDLE_IDS = [
  "read",
  "execution",
  "mutation",
  "observability",
] as const;

export type RuntimeCapabilityBundleId =
  typeof RUNTIME_CAPABILITY_BUNDLE_IDS[number];

export interface RuntimeCapabilityProfile {
  id: string;
  bundles: readonly RuntimeCapabilityBundleId[];
}

export const STANDALONE_RUNTIME_CAPABILITY_PROFILE: RuntimeCapabilityProfile = {
  id: "standalone",
  bundles: RUNTIME_CAPABILITY_BUNDLE_IDS,
};

export const READ_ONLY_RUNTIME_CAPABILITY_PROFILE: RuntimeCapabilityProfile = {
  id: "read-only",
  bundles: ["read"],
};

export function runtimeCapabilityProfile(
  id: string,
  bundles: readonly RuntimeCapabilityBundleId[],
): RuntimeCapabilityProfile {
  const unique = [...new Set(bundles)];
  return { id, bundles: unique };
}
