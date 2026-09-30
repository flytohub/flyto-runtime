import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
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
import {
  reactiveJobIdFromSessionId,
  reactiveJobSessionId,
  type ReactiveCommandRunner,
  type ReactiveJobReceipt,
  type ReactiveJobRecord,
} from "./reactive-command.js";

const packageScriptInputSchema = z.object({
  workspace_id: z.string().trim().min(1),
  working_directory: z.string().trim().min(1).optional(),
  timeout_seconds: z.number().int().positive().max(7_200).default(1_800),
}).strict();

const processStatusInputSchema = z.object({
  workspace_id: z.string().trim().min(1),
  session_id: z.string().trim().min(1),
}).strict();

export interface RuntimeExecutionCapabilityDependencies {
  workspaces: WorkspaceRegistry;
  reactiveCommands: ReactiveCommandRunner;
  durableOperations: DurableOperationStore;
}

export function registerExecutionRuntimeCapabilities(
  registry: RuntimeCapabilityRegistry,
  dependencies: RuntimeExecutionCapabilityDependencies,
): void {
  for (const provider of executionRuntimeCapabilityProviders(dependencies)) {
    registry.register(provider);
  }
}

export function executionRuntimeCapabilityProviders(
  dependencies: RuntimeExecutionCapabilityDependencies,
): RuntimeCapabilityProvider[] {
  return [
    packageScriptProvider("test.run", "test", dependencies),
    packageScriptProvider("build.run", "build", dependencies),
    processStatusProvider(dependencies),
  ];
}

function packageScriptProvider(
  capabilityId: "test.run" | "build.run",
  script: "test" | "build",
  { workspaces, reactiveCommands, durableOperations }: RuntimeExecutionCapabilityDependencies,
): RuntimeCapabilityProvider {
  return {
    capability: requiredCapability(capabilityId),
    async execute(rawInput, context) {
      const input = packageScriptInputSchema.parse(rawInput);
      const workspace = await workspaces.getWorkspace(input.workspace_id);
      const cwd = await workspaces.resolveWorkingDirectory(
        workspace,
        input.working_directory,
      );
      const project = packageScriptProject(cwd, script);
      if (!project.ok) {
        return {
          status: "failed",
          failure: {
            code: project.code,
            retryable: false,
            detail: project.detail,
          },
        };
      }

      const durable = await runDurableOperation(
        durableOperations,
        {
          tool: `capability:${capabilityId}`,
          operationId: context.invocation.operation_id,
          payload: {
            capability: capabilityId,
            workspace_id: input.workspace_id,
            working_directory: input.working_directory,
            timeout_seconds: input.timeout_seconds,
            script,
          },
        },
        async () => reactiveCommands.start({
          workspace_id: input.workspace_id,
          workspace_root: workspace.root,
          command: project.command,
          cwd,
          event_type: `capability.${script}.exited`,
          timeout_seconds: input.timeout_seconds,
        }),
      );

      const job = reactiveCommands.get(durable.value.job_id);
      return job && job.status !== "running"
        ? terminalJobOutcome(job, durable.replayed, project.packageManager, script)
        : acceptedJobOutcome(
            durable.value,
            durable.replayed,
            project.packageManager,
            script,
            input.workspace_id,
          );
    },
  };
}

function processStatusProvider(
  { workspaces, reactiveCommands }: RuntimeExecutionCapabilityDependencies,
): RuntimeCapabilityProvider {
  return {
    capability: requiredCapability("process.status"),
    async execute(rawInput) {
      const input = processStatusInputSchema.parse(rawInput);
      await workspaces.getWorkspace(input.workspace_id);
      const job = reactiveCommands.get(reactiveJobIdFromSessionId(input.session_id));
      if (!job || job.workspace_id !== input.workspace_id) {
        return {
          status: "failed",
          failure: {
            code: "process_not_found",
            retryable: false,
            detail: "The process session does not belong to this workspace or no longer exists.",
          },
        };
      }
      return {
        status: "success",
        output: processRecordOutput(job),
        evidence: [{ kind: "process.log", ref: job.evidence_ref }],
      };
    },
  };
}

function acceptedJobOutcome(
  receipt: ReactiveJobReceipt,
  replayed: boolean,
  packageManager: string,
  script: string,
  workspaceId: string,
): RuntimeCapabilityProviderOutcome {
  const sessionId = reactiveJobSessionId(receipt.job_id);
  return {
    status: "accepted",
    operation: {
      kind: "process",
      ref: sessionId,
      state: "running",
      wait: {
        capability: "event.wait",
        input: {
          workspace_id: workspaceId,
          correlation_id: receipt.job_id,
          type: receipt.event_type,
        },
      },
      inspect: {
        capability: "process.status",
        input: {
          workspace_id: workspaceId,
          session_id: sessionId,
        },
      },
    },
    output: {
      session_id: sessionId,
      package_manager: packageManager,
      script,
      replayed,
      command_digest: receipt.command_digest,
      started_at: receipt.started_at,
    },
    evidence: [{ kind: "process.log", ref: receipt.evidence_ref }],
  };
}

function terminalJobOutcome(
  job: ReactiveJobRecord,
  replayed: boolean,
  packageManager: string,
  script: string,
): RuntimeCapabilityProviderOutcome {
  const output = {
    ...processRecordOutput(job),
    package_manager: packageManager,
    script,
    replayed,
  };
  const evidence = [{ kind: "process.log", ref: job.evidence_ref }];
  if (job.status === "completed" && job.exit_code === 0) {
    return { status: "success", output, evidence };
  }
  return {
    status: "failed",
    output,
    evidence,
    failure: {
      code: job.status === "orphaned" ? "process_orphaned" : "process_failed",
      retryable: false,
      detail: job.status === "orphaned"
        ? "The Runtime restarted before the process reached a terminal result."
        : `The ${script} process exited unsuccessfully.`,
    },
  };
}

function processRecordOutput(job: ReactiveJobRecord): Record<string, unknown> {
  return {
    session_id: reactiveJobSessionId(job.job_id),
    status: job.status,
    running: job.status === "running",
    exit_code: job.exit_code,
    signal: job.signal,
    command_digest: job.command_digest,
    started_at: job.started_at,
    completed_at: job.completed_at,
    elapsed_ms: job.elapsed_ms,
    evidence_bytes: job.evidence_bytes,
    last_activity_at: job.last_activity_at,
    idle_ms: job.idle_ms,
    suspected_stall: job.suspected_stall,
  };
}

type PackageScriptProject =
  | { ok: true; packageManager: string; command: string }
  | { ok: false; code: string; detail: string };

function packageScriptProject(cwd: string, script: "test" | "build"): PackageScriptProject {
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) {
    return {
      ok: false,
      code: "unsupported_project",
      detail: "This provider currently requires a package.json in the selected working directory.",
    };
  }
  let packageJson: { packageManager?: unknown; scripts?: Record<string, unknown> };
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as typeof packageJson;
  } catch (error) {
    return {
      ok: false,
      code: "invalid_package_json",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (typeof packageJson.scripts?.[script] !== "string") {
    return {
      ok: false,
      code: "script_unavailable",
      detail: `package.json does not declare a ${script} script.`,
    };
  }
  const packageManager = detectPackageManager(cwd, packageJson.packageManager);
  return {
    ok: true,
    packageManager,
    command: `${packageManager} run ${script}`,
  };
}

function detectPackageManager(cwd: string, declared: unknown): "pnpm" | "npm" | "yarn" | "bun" {
  if (typeof declared === "string") {
    const name = declared.split("@", 1)[0];
    if (name === "pnpm" || name === "npm" || name === "yarn" || name === "bun") return name;
  }
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function requiredCapability(id: string) {
  const capability = runtimeCapability(id);
  if (!capability) throw new Error(`Runtime capability is missing from the catalog: ${id}`);
  return capability;
}
