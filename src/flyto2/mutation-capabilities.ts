import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import * as z from "zod/v4";
import { applyPatch } from "../apply-patch.js";
import { git, getGitEligibility } from "../git.js";
import type { ReviewCheckpointManager } from "../review-checkpoints.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { runtimeCapability } from "./capability-catalog.js";
import type {
  RuntimeCapabilityProvider,
  RuntimeCapabilityProviderOutcome,
  RuntimeCapabilityRegistry,
} from "./capability-provider.js";
import {
  type DurableOperationStore,
  runDurableOperation,
} from "./durable-operations.js";

const sourceEditInputSchema = z.object({
  workspace_id: z.string().trim().min(1),
  patch: z.string().min(1).max(2_000_000),
}).strict();

const gitMutateInputSchema = z.discriminatedUnion("action", [
  z.object({
    workspace_id: z.string().trim().min(1),
    action: z.literal("stage_workspace"),
  }).strict(),
  z.object({
    workspace_id: z.string().trim().min(1),
    action: z.literal("commit_staged"),
    message: z.string().trim().min(1).max(4_000),
  }).strict(),
]);

const MAX_CHANGED_PATHS = 200;
const GIT_MUTATION_TIMEOUT_MS = 120_000;

export interface RuntimeMutationCapabilityDependencies {
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
  durableOperations: DurableOperationStore;
}

export function registerMutationRuntimeCapabilities(
  registry: RuntimeCapabilityRegistry,
  dependencies: RuntimeMutationCapabilityDependencies,
): void {
  for (const provider of mutationRuntimeCapabilityProviders(dependencies)) {
    registry.register(provider);
  }
}

export function mutationRuntimeCapabilityProviders(
  dependencies: RuntimeMutationCapabilityDependencies,
): RuntimeCapabilityProvider[] {
  return [
    sourceEditProvider(dependencies),
    gitMutateProvider(dependencies),
  ];
}

function sourceEditProvider(
  { workspaces, reviewCheckpoints, durableOperations }: RuntimeMutationCapabilityDependencies,
): RuntimeCapabilityProvider {
  return {
    capability: requiredCapability("source.edit"),
    async execute(rawInput, context) {
      const input = sourceEditInputSchema.parse(rawInput);
      const workspace = await workspaces.getWorkspace(input.workspace_id);
      const requestPatchSha256 = sha256(input.patch);
      const requestPatchBytes = Buffer.byteLength(input.patch, "utf8");
      const durable = await runDurableOperation(
        durableOperations,
        {
          tool: "capability:source.edit",
          operationId: context.invocation.operation_id,
          payload: {
            workspace_id: input.workspace_id,
            request_patch_sha256: requestPatchSha256,
            request_patch_bytes: requestPatchBytes,
          },
        },
        async () => {
          const applied = await applyPatch(workspace.root, input.patch);
          const diffSha256 = sha256(applied.patch);
          const diffBytes = Buffer.byteLength(applied.patch, "utf8");
          const reviewRef = await nonAdvancingReviewRef(
            reviewCheckpoints,
            input.workspace_id,
            workspace.root,
          );
          return {
            files: applied.files.map(({ previousPath, ...file }) => ({
              ...file,
              previous_path: previousPath,
            })),
            additions: applied.additions,
            removals: applied.removals,
            request_patch_sha256: requestPatchSha256,
            diff_sha256: diffSha256,
            diff_bytes: diffBytes,
            review_ref: reviewRef,
          };
        },
      );

      const evidence = [
        {
          kind: "diff",
          ref: durable.value.review_ref ?? `sha256:${durable.value.diff_sha256}`,
          sha256: durable.value.diff_sha256,
          size: durable.value.diff_bytes,
        },
      ];
      return {
        status: "success",
        output: {
          ...durable.value,
          replayed: durable.replayed,
        },
        evidence,
      };
    },
  };
}

function gitMutateProvider(
  { workspaces, durableOperations }: RuntimeMutationCapabilityDependencies,
): RuntimeCapabilityProvider {
  return {
    capability: requiredCapability("git.mutate"),
    async execute(rawInput, context) {
      const input = gitMutateInputSchema.parse(rawInput);
      const workspace = await workspaces.getWorkspace(input.workspace_id);
      const eligibility = await getGitEligibility(workspace.root);
      if (!eligibility.ok || !eligibility.gitRoot) {
        return failed("not_git", eligibility.message ?? "Workspace is not inside a Git repository.");
      }
      const scope = await gitWorkspaceScope(eligibility.gitRoot, workspace.root);

      const durable = await runDurableOperation(
        durableOperations,
        {
          tool: "capability:git.mutate",
          operationId: context.invocation.operation_id,
          payload: input,
        },
        async () => input.action === "stage_workspace"
          ? stageWorkspace(eligibility.gitRoot!, scope)
          : commitStagedWorkspace(eligibility.gitRoot!, scope, input.message),
      );

      if (!durable.value.ok) {
        return {
          status: "failed",
          output: {
            action: input.action,
            replayed: durable.replayed,
            ...durable.value.output,
          },
          failure: {
            code: durable.value.code,
            retryable: false,
            detail: durable.value.detail,
          },
        };
      }

      const ref = durable.value.commit_sha
        ?? `workspace-stage:${input.workspace_id}`;
      return {
        status: "success",
        output: {
          action: input.action,
          replayed: durable.replayed,
          ...durable.value.output,
          commit_sha: durable.value.commit_sha,
        },
        evidence: [{ kind: "git", ref }],
      };
    },
  };
}

type GitMutationValue =
  | {
      ok: true;
      output: Record<string, unknown>;
      commit_sha?: string;
    }
  | {
      ok: false;
      code: string;
      detail: string;
      output?: Record<string, unknown>;
    };

async function stageWorkspace(gitRoot: string, scope: string): Promise<GitMutationValue> {
  await git(gitRoot, ["add", "-A", "--", scope], {
    timeoutMs: GIT_MUTATION_TIMEOUT_MS,
  });
  const staged = await stagedPaths(gitRoot);
  const inScope = staged.filter((path) => pathWithinScope(path, scope));
  return {
    ok: true,
    output: boundedPathsOutput(inScope, "staged"),
  };
}

async function commitStagedWorkspace(
  gitRoot: string,
  scope: string,
  message: string,
): Promise<GitMutationValue> {
  const staged = await stagedPaths(gitRoot);
  if (staged.length === 0) {
    return {
      ok: false,
      code: "nothing_staged",
      detail: "There are no staged changes to commit.",
    };
  }
  const outside = staged.filter((path) => !pathWithinScope(path, scope));
  if (outside.length > 0) {
    return {
      ok: false,
      code: "staged_changes_outside_workspace",
      detail: "Refusing to commit because the Git index contains staged paths outside this workspace.",
      output: boundedPathsOutput(outside, "outside_workspace"),
    };
  }

  await git(gitRoot, ["commit", "-m", message], {
    timeoutMs: GIT_MUTATION_TIMEOUT_MS,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
    },
  });
  const commitSha = (await git(gitRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return {
    ok: true,
    output: boundedPathsOutput(staged, "committed"),
    commit_sha: commitSha,
  };
}

async function stagedPaths(gitRoot: string): Promise<string[]> {
  const { stdout } = await git(gitRoot, [
    "diff",
    "--cached",
    "--name-only",
    "--no-renames",
    "-z",
  ]);
  return stdout.split("\0").filter(Boolean);
}

async function gitWorkspaceScope(gitRoot: string, workspaceRoot: string): Promise<string> {
  const [canonicalGitRoot, canonicalWorkspaceRoot] = await Promise.all([
    realpath(gitRoot),
    realpath(workspaceRoot),
  ]);
  const scope = relative(canonicalGitRoot, canonicalWorkspaceRoot);
  if (scope === "") return ".";
  if (isAbsolute(scope) || scope === ".." || scope.startsWith(`..${sep}`)) {
    throw new Error("Workspace root is outside the detected Git repository root.");
  }
  return scope.split(sep).join("/");
}

function pathWithinScope(path: string, scope: string): boolean {
  return scope === "." || path === scope || path.startsWith(`${scope}/`);
}

function boundedPathsOutput(
  paths: string[],
  prefix: string,
): Record<string, unknown> {
  return {
    [`${prefix}_count`]: paths.length,
    [`${prefix}_paths`]: paths.slice(0, MAX_CHANGED_PATHS),
    [`${prefix}_paths_truncated`]: paths.length > MAX_CHANGED_PATHS,
  };
}

async function nonAdvancingReviewRef(
  reviewCheckpoints: ReviewCheckpointManager,
  workspaceId: string,
  root: string,
): Promise<string | undefined> {
  try {
    const review = await reviewCheckpoints.reviewChanges({
      workspaceId,
      root,
      since: "workspace_open",
      markReviewed: false,
      includePatch: false,
    });
    return review.reviewRef;
  } catch {
    return undefined;
  }
}

function failed(code: string, detail: string): RuntimeCapabilityProviderOutcome {
  return {
    status: "failed",
    failure: { code, retryable: false, detail },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredCapability(id: string) {
  const capability = runtimeCapability(id);
  if (!capability) throw new Error(`Runtime capability is missing from the catalog: ${id}`);
  return capability;
}
