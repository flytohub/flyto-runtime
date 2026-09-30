import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  flyto2CapabilitySchema,
  flyto2CapabilityInvocationSchema,
  flyto2CapabilityResultSchema,
  type Flyto2Capability,
  type Flyto2CapabilityFailure,
  type Flyto2CapabilityInvocation,
  type Flyto2CapabilityResult,
  type Flyto2EvidenceRef,
} from "./protocol.js";

export type RuntimeCapabilityProviderOutcome =
  | {
      status: "success";
      output?: Record<string, unknown>;
      evidence?: Flyto2EvidenceRef[];
    }
  | {
      status: "failed";
      output?: Record<string, unknown>;
      evidence?: Flyto2EvidenceRef[];
      failure: Flyto2CapabilityFailure;
    };

export interface RuntimeCapabilityProviderContext {
  readonly invocation: Flyto2CapabilityInvocation;
  readonly signal?: AbortSignal;
}

export interface RuntimeCapabilityProvider {
  readonly capability: Flyto2Capability;
  execute(
    input: Readonly<Record<string, unknown>>,
    context: RuntimeCapabilityProviderContext,
  ): Promise<RuntimeCapabilityProviderOutcome>;
}

export type RuntimeCapabilityAuditType =
  | "capability.started"
  | "capability.completed"
  | "capability.failed";

export interface RuntimeCapabilityAuditRecord {
  type: RuntimeCapabilityAuditType;
  invocation_id: string;
  capability: string;
  revision: number;
  operation_id: string;
  workspace_id?: string;
  trace_id?: string;
  occurred_at: string;
  duration_ms?: number;
  evidence?: Flyto2EvidenceRef[];
  failure?: Flyto2CapabilityFailure;
}

export interface RuntimeCapabilityAuditSink {
  append(record: RuntimeCapabilityAuditRecord): void | Promise<void>;
}

export class RuntimeCapabilityRegistry {
  private readonly catalog = new Map<string, Flyto2Capability>();
  private readonly providers = new Map<string, RuntimeCapabilityProvider>();

  constructor(
    capabilities: readonly Flyto2Capability[],
    private readonly audit?: RuntimeCapabilityAuditSink,
  ) {
    for (const capability of capabilities) {
      const normalized = normalizeDescriptor(capability);
      const key = capabilityKey(normalized.id, normalized.revision);
      if (this.catalog.has(key)) {
        throw new Error(`Duplicate Runtime capability declaration: ${key}`);
      }
      this.catalog.set(key, normalized);
    }
  }

  register(provider: RuntimeCapabilityProvider): void {
    const normalized = normalizeDescriptor(provider.capability);
    const key = capabilityKey(normalized.id, normalized.revision);
    const declared = this.catalog.get(key);
    if (!declared) {
      throw new Error(`Runtime capability provider is not declared in the manifest catalog: ${key}`);
    }
    if (!sameDescriptor(declared, normalized)) {
      throw new Error(`Runtime capability provider metadata does not match the catalog: ${key}`);
    }
    if (this.providers.has(key)) {
      throw new Error(`Runtime capability provider already registered: ${key}`);
    }
    this.providers.set(key, provider);
  }

  registeredCapabilities(): Flyto2Capability[] {
    return [...this.providers.values()].map(({ capability }) => normalizeDescriptor(capability));
  }

  async execute(
    request: Flyto2CapabilityInvocation,
    signal?: AbortSignal,
  ): Promise<Flyto2CapabilityResult> {
    const invocation = flyto2CapabilityInvocationSchema.parse(request);
    const key = capabilityKey(invocation.capability, invocation.revision);
    const provider = this.providers.get(key);
    if (!provider) throw new Error(`Runtime capability provider is unavailable: ${key}`);

    const startedAt = new Date();
    await this.audit?.append(auditRecord("capability.started", invocation, startedAt));

    let outcome: RuntimeCapabilityProviderOutcome;
    try {
      outcome = await provider.execute(invocation.input, { invocation, signal });
    } catch (error) {
      outcome = {
        status: "failed",
        failure: {
          code: "provider_error",
          retryable: false,
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const completedAt = new Date();
    const result = flyto2CapabilityResultSchema.parse({
      schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
      invocation_id: invocation.invocation_id,
      capability: invocation.capability,
      revision: invocation.revision,
      status: outcome.status,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      output: outcome.output ?? {},
      evidence: outcome.evidence ?? [],
      failure: outcome.status === "failed" ? outcome.failure : undefined,
    });

    await this.audit?.append({
      ...auditRecord(
        result.status === "success" ? "capability.completed" : "capability.failed",
        invocation,
        completedAt,
      ),
      duration_ms: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      evidence: result.evidence,
      failure: result.failure,
    });
    return result;
  }
}

function capabilityKey(id: string, revision: number): string {
  return `${id}@${revision}`;
}

function normalizeDescriptor(capability: Flyto2Capability): Flyto2Capability {
  const normalized = flyto2CapabilitySchema.parse(capability);
  return { ...normalized, evidence: [...normalized.evidence] };
}

function sameDescriptor(left: Flyto2Capability, right: Flyto2Capability): boolean {
  return left.id === right.id
    && left.revision === right.revision
    && left.risk_level === right.risk_level
    && left.approval === right.approval
    && left.evidence.length === right.evidence.length
    && left.evidence.every((value, index) => value === right.evidence[index]);
}

function auditRecord(
  type: RuntimeCapabilityAuditType,
  invocation: Flyto2CapabilityInvocation,
  occurredAt: Date,
): RuntimeCapabilityAuditRecord {
  return {
    type,
    invocation_id: invocation.invocation_id,
    capability: invocation.capability,
    revision: invocation.revision,
    operation_id: invocation.operation_id,
    workspace_id: invocation.workspace_id,
    trace_id: invocation.trace_id,
    occurred_at: occurredAt.toISOString(),
  };
}
