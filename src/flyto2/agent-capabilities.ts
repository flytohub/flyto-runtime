import * as z from "zod/v4";
import type { LocalAgentClient } from "../local-agent-client.js";
import { toAgentErrorPayload } from "../local-agent-errors.js";
import type { LocalAgentRecord } from "../local-agent-store.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { runtimeCapability } from "./capability-catalog.js";
import type {
  RuntimeCapabilityProvider,
  RuntimeCapabilityProviderOutcome,
  RuntimeCapabilityRegistry,
} from "./capability-provider.js";
import {
  DurableOperationStore,
  runDurableOperation,
} from "./durable-operations.js";

const writeModeSchema = z.enum(["read_only", "allowed", "full_access"]);

const delegateInputSchema = z.object({
  workspace_id: z.string().trim().min(1),
  target: z.string().trim().min(1).max(128),
  prompt: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).max(256).optional(),
  effort: z.string().trim().min(1).max(128).optional(),
  write_mode: writeModeSchema.default("read_only"),
}).strict();

const continueInputSchema = z.object({
  workspace_id: z.string().trim().min(1),
  agent_id: z.string().trim().min(1).max(128),
  prompt: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).max(256).optional(),
  effort: z.string().trim().min(1).max(128).optional(),
  write_mode: writeModeSchema.optional(),
}).strict();

const inspectInputSchema = z.object({
  workspace_id: z.string().trim().min(1),
  agent_id: z.string().trim().min(1).max(128),
}).strict();

const waitInputSchema = inspectInputSchema.extend({
  timeout_ms: z.number().int().min(0).max(25_000).default(25_000),
}).strict();

export interface RuntimeAgentCapabilityDependencies {
  workspaces: WorkspaceRegistry;
  client: Pick<LocalAgentClient, "start" | "continue" | "get" | "wait">;
  durableOperations: DurableOperationStore;
}

type AgentAdmissionReceipt =
  | { ok: true; agent_id: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

/** Registers the optional delegated-agent provider set on an existing Runtime registry. */
export function registerAgentRuntimeCapabilities(
  registry: RuntimeCapabilityRegistry,
  dependencies: RuntimeAgentCapabilityDependencies,
): void {
  for (const provider of agentRuntimeCapabilityProviders(dependencies)) {
    registry.register(provider);
  }
}

/** Creates provider adapters for delegated start/continue/inspect/wait operations. */
export function agentRuntimeCapabilityProviders(
  dependencies: RuntimeAgentCapabilityDependencies,
): RuntimeCapabilityProvider[] {
  return [
    delegateProvider(dependencies),
    continueProvider(dependencies),
    inspectProvider(dependencies),
    waitProvider(dependencies),
  ];
}

function delegateProvider(
  { workspaces, client, durableOperations }: RuntimeAgentCapabilityDependencies,
): RuntimeCapabilityProvider {
  return {
    capability: requiredCapability("agent.delegate"),
    async execute(rawInput, context) {
      const input = delegateInputSchema.parse(rawInput);
      const workspace = await workspaces.getWorkspace(input.workspace_id);
      const admission = await runDurableOperation(
        durableOperations,
        {
          tool: "capability:agent.delegate",
          operationId: context.invocation.operation_id,
          payload: input,
        },
        async (): Promise<AgentAdmissionReceipt> => {
          const result = await client.start({
            target: input.target,
            prompt: input.prompt,
            workspaceRoot: workspace.root,
            workspaceId: input.workspace_id,
            model: input.model,
            effort: input.effort,
            writeMode: input.write_mode,
          });
          return result.isErr()
            ? { ok: false, error: capabilityAgentError(result.error) }
            : { ok: true, agent_id: result.value.id };
        },
      );
      if (!admission.value.ok) return failedOutcome(admission.value.error);
      return currentAgentOutcome(
        client,
        workspace.root,
        input.workspace_id,
        admission.value.agent_id,
        admission.replayed,
      );
    },
  };
}

function continueProvider(
  { workspaces, client, durableOperations }: RuntimeAgentCapabilityDependencies,
): RuntimeCapabilityProvider {
  return {
    capability: requiredCapability("agent.continue"),
    async execute(rawInput, context) {
      const input = continueInputSchema.parse(rawInput);
      const workspace = await workspaces.getWorkspace(input.workspace_id);
      const admission = await runDurableOperation(
        durableOperations,
        {
          tool: "capability:agent.continue",
          operationId: context.invocation.operation_id,
          payload: input,
        },
        async (): Promise<AgentAdmissionReceipt> => {
          const result = await client.continue(
            input.agent_id,
            input.prompt,
            {
              model: input.model,
              effort: input.effort,
              writeMode: input.write_mode,
            },
            { workspaceId: input.workspace_id, workspaceRoot: workspace.root },
          );
          return result.isErr()
            ? { ok: false, error: capabilityAgentError(result.error) }
            : { ok: true, agent_id: result.value.id };
        },
      );
      if (!admission.value.ok) return failedOutcome(admission.value.error);
      return currentAgentOutcome(
        client,
        workspace.root,
        input.workspace_id,
        admission.value.agent_id,
        admission.replayed,
      );
    },
  };
}

function inspectProvider(
  { workspaces, client }: RuntimeAgentCapabilityDependencies,
): RuntimeCapabilityProvider {
  return {
    capability: requiredCapability("agent.inspect"),
    async execute(rawInput) {
      const input = inspectInputSchema.parse(rawInput);
      const workspace = await workspaces.getWorkspace(input.workspace_id);
      return currentAgentOutcome(
        client,
        workspace.root,
        input.workspace_id,
        input.agent_id,
        false,
      );
    },
  };
}

function waitProvider(
  { workspaces, client }: RuntimeAgentCapabilityDependencies,
): RuntimeCapabilityProvider {
  return {
    capability: requiredCapability("agent.wait"),
    async execute(rawInput) {
      const input = waitInputSchema.parse(rawInput);
      const workspace = await workspaces.getWorkspace(input.workspace_id);
      const scope = { workspaceId: input.workspace_id, workspaceRoot: workspace.root };
      const result = await client.wait([input.agent_id], scope, input.timeout_ms);
      if (result.isErr()) return failedOutcome(capabilityAgentError(result.error));
      const state = result.value[0];
      if (!state) {
        return failedOutcome({
          code: "agent_state_unavailable",
          retryable: true,
          message: "The delegated agent returned no state.",
        });
      }
      if (state.status === "running") {
        return acceptedAgentOutcome(input.workspace_id, input.agent_id, false);
      }
      if (state.status === "completed") {
        return {
          status: "success",
          output: compact({
            agent_id: input.agent_id,
            status: state.status,
            response: state.response,
          }),
          evidence: agentEvidence(input.agent_id),
        };
      }
      return failedOutcome({
        code: state.error?.code ?? `agent_${state.status}`,
        retryable: state.error?.retryable ?? false,
        message: safeAgentFailureMessage(state.error?.code ?? `agent_${state.status}`),
      }, input.agent_id);
    },
  };
}

async function currentAgentOutcome(
  client: RuntimeAgentCapabilityDependencies["client"],
  workspaceRoot: string,
  workspaceId: string,
  agentId: string,
  replayed: boolean,
): Promise<RuntimeCapabilityProviderOutcome> {
  const result = await client.get(agentId, { workspaceId, workspaceRoot });
  if (result.isErr()) return failedOutcome(capabilityAgentError(result.error), agentId);
  return agentRecordOutcome(result.value, workspaceId, replayed);
}

function agentRecordOutcome(
  record: LocalAgentRecord,
  workspaceId: string,
  replayed: boolean,
): RuntimeCapabilityProviderOutcome {
  if (record.status === "starting" || record.status === "running") {
    return acceptedAgentOutcome(workspaceId, record.id, replayed);
  }
  if (record.status === "idle") {
    return {
      status: "success",
      output: compact({
        agent_id: record.id,
        status: record.status,
        response: record.latestResponse,
        replayed,
      }),
      evidence: agentEvidence(record.id),
    };
  }
  return failedOutcome({
    code: record.errorCode ?? `agent_${record.status}`,
    retryable: record.errorRetryable ?? false,
    message: safeAgentFailureMessage(record.errorCode ?? `agent_${record.status}`),
  }, record.id, replayed);
}

function acceptedAgentOutcome(
  workspaceId: string,
  agentId: string,
  replayed: boolean,
): RuntimeCapabilityProviderOutcome {
  return {
    status: "accepted",
    operation: {
      kind: "agent",
      ref: agentId,
      state: "running",
      wait: {
        capability: "agent.wait",
        input: { workspace_id: workspaceId, agent_id: agentId },
      },
      inspect: {
        capability: "agent.inspect",
        input: { workspace_id: workspaceId, agent_id: agentId },
      },
    },
    output: { agent_id: agentId, status: "running", replayed },
    evidence: agentEvidence(agentId),
  };
}

function failedOutcome(
  error: { code: string; message: string; retryable: boolean },
  agentId?: string,
  replayed?: boolean,
): RuntimeCapabilityProviderOutcome {
  return {
    status: "failed",
    output: compact({ agent_id: agentId, replayed }),
    evidence: agentId ? agentEvidence(agentId) : [],
    failure: {
      code: error.code,
      retryable: error.retryable,
      detail: error.message,
    },
  };
}

function capabilityAgentError(error: Parameters<typeof toAgentErrorPayload>[0]) {
  const payload = toAgentErrorPayload(error);
  return {
    code: String(payload.code),
    retryable: payload.retryable ?? false,
    message: safeAgentFailureMessage(String(payload.code)),
  };
}

function safeAgentFailureMessage(code: string): string {
  switch (code) {
    case "UNKNOWN_TARGET":
      return "The requested delegated-agent target is unavailable.";
    case "AGENT_NOT_FOUND":
      return "The delegated agent could not be found in this workspace.";
    case "PROVIDER_DISABLED":
    case "PROVIDER_NOT_CONFIGURED":
      return "The requested delegated-agent provider is unavailable.";
    case "AGENT_CONFLICT":
      return "The delegated agent already has an active turn.";
    case "WORKSPACE_MISMATCH":
    case "WORKSPACE_NOT_ALLOWED":
    case "WORKSPACE_SCOPE_REQUIRED":
      return "The delegated-agent operation is not valid for this workspace scope.";
    default:
      return "The delegated-agent operation failed. Inspect Runtime-local diagnostics for details.";
  }
}

function agentEvidence(agentId: string) {
  return [{ kind: "agent.session", ref: `flyto2://agent/${agentId}` }];
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function requiredCapability(id: string) {
  const capability = runtimeCapability(id);
  if (!capability) throw new Error(`Runtime capability is missing from the catalog: ${id}`);
  return capability;
}
