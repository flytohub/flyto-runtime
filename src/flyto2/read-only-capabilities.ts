import * as z from "zod/v4";
import { git, getGitEligibility } from "../git.js";
import type { ReviewCheckpointManager } from "../review-checkpoints.js";
import { readWorkspaceFile } from "../workspace-read.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { runtimeCapability } from "./capability-catalog.js";
import type {
  RuntimeCapabilityProvider,
  RuntimeCapabilityRegistry,
} from "./capability-provider.js";

const workspaceOpenInputSchema = z.object({
  path: z.string().trim().min(1),
  mode: z.literal("checkout").default("checkout"),
}).strict();

const sourceReadInputSchema = z.object({
  workspace_id: z.string().trim().min(1),
  path: z.string().trim().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(2_000).optional(),
}).strict();

const workspaceIdInputSchema = z.object({
  workspace_id: z.string().trim().min(1),
}).strict();

const reviewDiffInputSchema = z.object({
  workspace_id: z.string().trim().min(1),
  since: z.enum(["last_shown", "workspace_open"]).optional(),
  review_ref: z.string().trim().min(1).optional(),
  include_patch: z.boolean().default(false),
}).strict();

const MAX_REVIEW_PATCH_CHARS = 128_000;
const MAX_GIT_STATUS_CHARS = 32_000;

export interface RuntimeReadOnlyCapabilityDependencies {
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
}

export function registerReadOnlyRuntimeCapabilities(
  registry: RuntimeCapabilityRegistry,
  dependencies: RuntimeReadOnlyCapabilityDependencies,
): void {
  for (const provider of readOnlyRuntimeCapabilityProviders(dependencies)) {
    registry.register(provider);
  }
}

export function readOnlyRuntimeCapabilityProviders(
  { workspaces, reviewCheckpoints }: RuntimeReadOnlyCapabilityDependencies,
): RuntimeCapabilityProvider[] {
  return [
    {
      capability: requiredCapability("workspace.open"),
      async execute(rawInput, providerContext) {
        const input = workspaceOpenInputSchema.parse(rawInput);
        const workspaceContext = await workspaces.openWorkspace({
          path: input.path,
          mode: input.mode,
        }, {
          conversationScopeId: providerContext.invocation.trace_id
            ? `capability:${providerContext.invocation.trace_id}`
            : undefined,
        });
        await reviewCheckpoints.initializeWorkspace({
          workspaceId: workspaceContext.workspace.id,
          root: workspaceContext.workspace.root,
        });
        return {
          status: "success",
          output: {
            workspace_id: workspaceContext.workspace.id,
            mode: workspaceContext.workspace.mode,
          },
          evidence: [{ kind: "workspace", ref: workspaceContext.workspace.id }],
        };
      },
    },
    {
      capability: requiredCapability("source.read"),
      async execute(rawInput) {
        const input = sourceReadInputSchema.parse(rawInput);
        const read = await readWorkspaceFile(workspaces, {
          workspaceId: input.workspace_id,
          path: input.path,
          offset: input.offset,
          limit: input.limit,
        });
        if (read.response.isError) {
          return {
            status: "failed",
            failure: {
              code: "read_failed",
              retryable: false,
              detail: read.result,
            },
          };
        }
        return {
          status: "success",
          output: { result: read.result },
          evidence: [{ kind: "file", ref: input.path }],
        };
      },
    },
    {
      capability: requiredCapability("git.inspect"),
      async execute(rawInput) {
        const input = workspaceIdInputSchema.parse(rawInput);
        const workspace = await workspaces.getWorkspace(input.workspace_id);
        const eligibility = await getGitEligibility(workspace.root);
        if (!eligibility.ok || !eligibility.gitRoot) {
          return {
            status: "success",
            output: {
              available: false,
              reason: eligibility.reason ?? "not_git",
            },
            evidence: [{ kind: "git", ref: input.workspace_id }],
          };
        }

        const [head, branch, rawStatus] = await Promise.all([
          eligibility.hasHead
            ? git(eligibility.gitRoot, ["rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim())
            : Promise.resolve(undefined),
          git(eligibility.gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
            .then(({ stdout }) => stdout.trim() || undefined)
            .catch(() => undefined),
          git(eligibility.gitRoot, ["status", "--short", "--branch"])
            .then(({ stdout }) => stdout.trimEnd()),
        ]);
        const statusTruncated = rawStatus.length > MAX_GIT_STATUS_CHARS;
        const status = statusTruncated
          ? rawStatus.slice(0, MAX_GIT_STATUS_CHARS)
          : rawStatus;
        return {
          status: "success",
          output: {
            available: true,
            has_head: eligibility.hasHead ?? false,
            head,
            branch,
            dirty: status.split(/\r?\n/).some((line) => line.length > 0 && !line.startsWith("## ")),
            status,
            status_truncated: statusTruncated,
          },
          evidence: [{ kind: "git", ref: input.workspace_id }],
        };
      },
    },
    {
      capability: requiredCapability("review.diff"),
      async execute(rawInput) {
        const input = reviewDiffInputSchema.parse(rawInput);
        const workspace = await workspaces.getWorkspace(input.workspace_id);
        const review = input.review_ref
          ? await reviewCheckpoints.reviewByRef({
              workspaceId: input.workspace_id,
              root: workspace.root,
              reviewRef: input.review_ref,
              includePatch: input.include_patch,
            })
          : await reviewCheckpoints.reviewChanges({
              workspaceId: input.workspace_id,
              root: workspace.root,
              since: input.since,
              markReviewed: false,
              includePatch: input.include_patch,
            });
        const patch = input.include_patch ? review.patch : undefined;
        return {
          status: "success",
          output: {
            review_ref: review.reviewRef,
            result: review.result,
            summary: review.summary,
            files: review.files,
            ...(patch === undefined
              ? {}
              : patch.length <= MAX_REVIEW_PATCH_CHARS
                ? { patch, patch_truncated: false }
                : {
                    patch: patch.slice(0, MAX_REVIEW_PATCH_CHARS),
                    patch_truncated: true,
                  }),
          },
          evidence: [{ kind: "diff", ref: review.reviewRef }],
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
