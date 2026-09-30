import {
  flyto2CapabilitySchema,
  type Flyto2Capability,
} from "./protocol.js";

const CAPABILITY_DEFINITIONS = [
  ["workspace.open", "low", "none", ["workspace"]],
  ["source.read", "low", "none", ["file"]],
  ["source.edit", "high", "policy", ["diff", "file"]],
  ["process.run", "high", "policy", ["process", "log"]],
  ["process.status", "low", "none", ["process", "log"]],
  ["git.inspect", "low", "none", ["git"]],
  ["git.mutate", "high", "policy", ["git", "diff"]],
  ["test.run", "medium", "policy", ["test", "log"]],
  ["build.run", "medium", "policy", ["build", "log"]],
  ["review.diff", "low", "none", ["diff"]],
  ["agent.delegate", "high", "policy", ["agent", "log"]],
  ["event.stream", "low", "none", ["event"]],
  ["event.wait", "low", "none", ["event"]],
  ["evidence.read", "low", "none", ["log", "evidence"]],
  ["process.reactive", "high", "policy", ["process", "event", "log"]],
  ["file.watch", "medium", "policy", ["event"]],
] as const satisfies readonly [
  string,
  Flyto2Capability["risk_level"],
  Flyto2Capability["approval"],
  readonly string[],
][];

const CATALOG = CAPABILITY_DEFINITIONS.map(([id, riskLevel, approval, evidence]) =>
  flyto2CapabilitySchema.parse({
    id,
    revision: 1,
    risk_level: riskLevel,
    approval,
    evidence: [...evidence],
  }));

assertUniqueCapabilities(CATALOG);

export function runtimeCapabilityCatalog(): Flyto2Capability[] {
  return CATALOG.map((capability) => ({
    ...capability,
    evidence: [...capability.evidence],
  }));
}

export function runtimeCapability(
  id: string,
  revision = 1,
): Flyto2Capability | undefined {
  const capability = CATALOG.find(
    (candidate) => candidate.id === id && candidate.revision === revision,
  );
  return capability
    ? { ...capability, evidence: [...capability.evidence] }
    : undefined;
}

function assertUniqueCapabilities(capabilities: readonly Flyto2Capability[]): void {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    const key = `${capability.id}@${capability.revision}`;
    if (seen.has(key)) throw new Error(`Duplicate Runtime capability: ${key}`);
    seen.add(key);
  }
}
