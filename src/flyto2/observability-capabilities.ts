import * as z from "zod/v4";
import type { WorkspaceRegistry } from "../workspaces.js";
import { runtimeCapability } from "./capability-catalog.js";
import type {
  RuntimeCapabilityProvider,
  RuntimeCapabilityRegistry,
} from "./capability-provider.js";
import type { ReactiveCommandRunner } from "./reactive-command.js";
import type { RuntimeEventStore } from "./runtime-events.js";

const eventWaitInputSchema = z.object({
  workspace_id: z.string().trim().min(1),
  correlation_id: z.string().trim().min(1).max(256),
  type: z.string().trim().min(1).max(128).optional(),
  after_sequence: z.number().int().nonnegative().optional(),
  timeout_ms: z.number().int().min(0).max(25_000).optional(),
}).strict();

const evidenceReadInputSchema = z.object({
  workspace_id: z.string().trim().min(1),
  ref: z.string().trim().min(1).max(512),
  max_characters: z.number().int().min(256).max(256_000).optional(),
}).strict();

export interface RuntimeObservabilityCapabilityDependencies {
  workspaces: WorkspaceRegistry;
  runtimeEvents: RuntimeEventStore;
  reactiveCommands: ReactiveCommandRunner;
}

export function registerObservabilityRuntimeCapabilities(
  registry: RuntimeCapabilityRegistry,
  dependencies: RuntimeObservabilityCapabilityDependencies,
): void {
  for (const provider of observabilityRuntimeCapabilityProviders(dependencies)) {
    registry.register(provider);
  }
}

export function observabilityRuntimeCapabilityProviders(
  { workspaces, runtimeEvents, reactiveCommands }: RuntimeObservabilityCapabilityDependencies,
): RuntimeCapabilityProvider[] {
  return [
    {
      capability: requiredCapability("event.wait"),
      async execute(rawInput) {
        const input = eventWaitInputSchema.parse(rawInput);
        await workspaces.getWorkspace(input.workspace_id);
        const event = await runtimeEvents.wait({
          after_sequence: input.after_sequence,
          workspace_id: input.workspace_id,
          type: input.type,
          correlation_id: input.correlation_id,
          timeout_ms: input.timeout_ms,
        });
        return {
          status: "success",
          output: {
            matched: Boolean(event),
            event: event ?? null,
            cursor: event?.sequence ?? input.after_sequence ?? 0,
          },
          evidence: event?.evidence ?? [],
        };
      },
    },
    {
      capability: requiredCapability("evidence.read"),
      async execute(rawInput) {
        const input = evidenceReadInputSchema.parse(rawInput);
        await workspaces.getWorkspace(input.workspace_id);
        let evidence;
        try {
          evidence = reactiveCommands.readEvidence(
            input.ref,
            input.max_characters,
          );
        } catch {
          return {
            status: "failed",
            failure: {
              code: "evidence_not_found",
              retryable: false,
              detail: "The evidence reference is unavailable for this Runtime.",
            },
          };
        }
        if (evidence.job.workspace_id !== input.workspace_id) {
          return {
            status: "failed",
            failure: {
              code: "evidence_not_found",
              retryable: false,
              detail: "The evidence reference is unavailable for this workspace.",
            },
          };
        }
        return {
          status: "success",
          output: {
            ref: input.ref,
            text: evidence.text,
            truncated: evidence.truncated,
            process: {
              status: evidence.job.status,
              exit_code: evidence.job.exit_code,
              signal: evidence.job.signal,
              started_at: evidence.job.started_at,
              completed_at: evidence.job.completed_at,
            },
          },
          evidence: [{ kind: "process.log", ref: input.ref }],
        };
      },
    },
  ];
}

function requiredCapability(id: string) {
  const capability = runtimeCapability(id);
  if (!capability) throw new Error(`Runtime capability is missing from the catalog: ${id}`);
  return capability;
}
