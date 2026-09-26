import { readFileSync } from "node:fs";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { AccessDeniedError } from "./roots.js";
import { readFileTool } from "./pi-tools.js";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import type { ReviewCheckpointManager } from "./review-checkpoints.js";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { LEGACY_TASK_COMMAND } from "./mcp-legacy-input.js";
import { formatPathForPrompt } from "./skills.js";
import {
  buildLocalAgentCatalog,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
} from "./tool-surfaces/shared.js";
import {
  toolNames,
  workspaceIdDescription,
} from "./tool-surfaces/types.js";
import {
  formatAgentsPath,
  type WorkspaceContext,
  type WorkspaceRegistry,
} from "./workspaces.js";

interface WorkspaceToolRegistrationOptions {
  server: McpRegistrationTarget;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[];
}

interface OpenWorkspaceInput {
  path: string;
  mode?: "checkout" | "worktree";
  base_ref?: string;
}

const DEFAULT_READ_LIMIT_LINES = 240;
const DEFAULT_READ_MAX_CHARS = 12_000;
const READ_TRUNCATION_MARKER =
  "\n... read output truncated; use a smaller line range or a targeted command ...\n";

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

/** Explain the filesystem boundary to hosts that cannot inspect the user's machine directly. */
export function allowedRootsSentence(allowedRoots: readonly string[]): string {
  return allowedRoots.length === 0
    ? "No allowed roots are configured; ask the user to add one with flyto2-runtime setup."
    : `Allowed roots: ${allowedRoots.join(", ")}. To find a folder the user names, open the allowed root and list it; do not search outside these roots.`;
}

/** Register the workspace-oriented MCP tools on one registration target. */
export function registerWorkspaceTools(options: WorkspaceToolRegistrationOptions): void {
  registerOpenWorkspaceTool(options);
  registerReadTool(options);
  registerShowChangesTool(options);
}

function registerOpenWorkspaceTool(options: WorkspaceToolRegistrationOptions): void {
  const { server, config } = options;

  server.registerTool(
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a project once and return its reusable workspace_id. Use mode=\"worktree\" only for isolated Git work.",
      inputSchema: {
        path: z
          .string()
          .describe(
            `Project path inside an allowed root. ${allowedRootsSentence(config.allowedRoots)}`,
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "checkout (default) or isolated Git worktree.",
          ),
        base_ref: z
          .string()
          .optional()
          .describe("Optional worktree base ref; defaults to HEAD."),
      },
      outputSchema: {
        workspace_id: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        source_root: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            base_ref: z.string(),
            base_sha: z.string(),
            dirty_source: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agents_files: z.array(workspaceAgentsFileOutputSchema).optional(),
        available_agents_files: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        ...(config.toolMode === "claude"
          ? {
              agent_providers: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
              agents: z.array(workspaceLocalAgentOutputSchema).optional(),
              skill_diagnostics: z.array(z.unknown()).optional(),
            }
          : {}),
        review: z.discriminatedUnion("available", [
          z.object({ available: z.literal(true) }),
          z.object({
            available: z.literal(false),
            reason: z.string(),
          }),
        ]),
        instruction: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input, { _meta }) => handleOpenWorkspace(options, input, _meta),
  );
}

async function handleOpenWorkspace(
  options: WorkspaceToolRegistrationOptions,
  input: OpenWorkspaceInput,
  requestMeta: unknown,
) {
  const {
    config,
    workspaces,
    reviewCheckpoints,
    resolveLocalAgentProviders,
  } = options;
  const startedAt = performance.now();
  const context = await openWorkspaceContext(
    workspaces,
    config,
    input,
    requestMeta,
  );
  const { workspace } = context;
  const review = await reviewCheckpoints.initializeWorkspace({
    workspaceId: workspace.id,
    root: workspace.root,
  });
  const presentation = buildWorkspacePresentation(
    context,
    config,
    resolveLocalAgentProviders,
  );

  logToolCall(config, {
    tool: "open_workspace",
    workspaceId: workspace.id,
    path: workspace.root,
    success: true,
    durationMs: Math.round(performance.now() - startedAt),
  });

  return {
    content: [{ type: "text" as const, text: presentation.resultText }],
    structuredContent: {
      workspace_id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      source_root: workspace.sourceRoot,
      worktree: workspace.worktree
        ? {
            path: workspace.worktree.path,
            base_ref: workspace.worktree.baseRef,
            base_sha: workspace.worktree.baseSha,
            dirty_source: workspace.worktree.dirtySource,
            detached: workspace.worktree.detached,
            managed: workspace.worktree.managed,
          }
        : undefined,
      review,
      ...(context.includeDiscoveryContext
        ? {
            agents_files: presentation.loadedAgentsFiles,
            available_agents_files: presentation.availableAgentsFileOutputs,
            skills: presentation.visibleSkills,
            ...(config.toolMode === "claude"
              ? {
                  agent_providers: presentation.visibleAgentProviders,
                  agents: presentation.visibleAgents,
                  skill_diagnostics: workspace.skillDiagnostics,
                }
              : {}),
          }
        : {}),
      instruction: presentation.instruction,
    },
  };
}

async function openWorkspaceContext(
  workspaces: WorkspaceRegistry,
  config: ServerConfig,
  input: OpenWorkspaceInput,
  requestMeta: unknown,
): Promise<WorkspaceContext> {
  try {
    return await workspaces.openWorkspace(
      { path: input.path, mode: input.mode, baseRef: input.base_ref },
      { conversationScopeId: conversationScopeIdFromRequestMeta(requestMeta) },
    );
  } catch (error) {
    // The host cannot see the filesystem: name the roots it may use, so it
    // opens one and looks inside instead of guessing or searching $HOME.
    if (error instanceof AccessDeniedError) {
      throw new AccessDeniedError(
        `${error.message}. ${allowedRootsSentence(config.allowedRoots)}`,
      );
    }
    throw error;
  }
}

function buildWorkspacePresentation(
  context: WorkspaceContext,
  config: ServerConfig,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
) {
  const { workspace, agentsFiles, availableAgentsFiles } = context;
  // ChatGPT/Codex owns its coding loop. Even if an older user config asks to
  // preload subagent instructions, keep delegation opt-in so open_workspace
  // does not spend context on a workflow the host did not explicitly request.
  const preloadSubagents = config.toolMode === "claude"
    && config.subagents.enabled
    && config.subagents.instructions === "preload";
  const subagentsSkill = workspace.skills.find((skill) => skill.name === "subagents");
  const preloadedSubagentInstructions = context.includeDiscoveryContext
    && preloadSubagents && subagentsSkill
    ? readFileSync(subagentsSkill.filePath, "utf8")
    : undefined;
  const availableSkills = workspace.skills
    .filter((skill) => !skill.disableModelInvocation)
    .filter((skill) => !(preloadSubagents && skill.name === "subagents"))
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: formatPathForPrompt(skill.filePath),
    }));
  // Codex mode exposes only the six workspace primitives, so local-agent
  // provider/profile data cannot lead to a callable tool. Keep that catalog
  // out of ChatGPT's initial context and avoid probing providers for it.
  const agentCatalog = context.includeDiscoveryContext && config.toolMode === "claude"
    ? buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      )
    : { providers: [], profiles: [] };
  const availableAgentProviders = agentCatalog.providers
    .filter((provider) => provider.usable)
    .map((provider) => ({
      id: provider.id,
      model: provider.model,
      effort: provider.effort,
      note: provider.note,
    }));
  const availableAgents = agentCatalog.profiles;
  const allLoadedAgentsFiles = agentsFiles.map((file) => ({
    path: formatAgentsPath(file.path, workspace.root),
    content: file.content,
  }));
  const allAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
    path: formatAgentsPath(file.path, workspace.root),
  }));
  const visibleSkills = context.includeDiscoveryContext ? availableSkills : [];
  const visibleAgentProviders = context.includeDiscoveryContext ? availableAgentProviders : [];
  const visibleAgents = context.includeDiscoveryContext ? availableAgents : [];
  const loadedAgentsFiles = context.includeDiscoveryContext ? allLoadedAgentsFiles : [];
  const availableAgentsFileOutputs = context.includeDiscoveryContext
    ? allAvailableAgentsFiles
    : [];
  const baseInstruction = workspaceBaseInstruction(config.skillsEnabled);
  const instruction = workspaceInstruction(
    context,
    baseInstruction,
    config.toolMode,
    preloadedSubagentInstructions,
  );

  return {
    visibleSkills,
    visibleAgentProviders,
    visibleAgents,
    loadedAgentsFiles,
    availableAgentsFileOutputs,
    instruction,
    resultText: workspaceResultText(context, {
      loadedAgentsFiles,
      availableAgentsFileOutputs,
      visibleSkills,
      visibleAgentProviders,
      visibleAgents,
      instruction,
    }),
  };
}

function workspaceBaseInstruction(skillsEnabled: boolean): string {
  return skillsEnabled
    ? "Use this workspace_id for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agents_files instructions. Before working under a path listed in available_agents_files, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
    : "Use this workspace_id for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agents_files instructions. Before working under a path listed in available_agents_files, read that instruction file.";
}

function workspaceInstruction(
  context: WorkspaceContext,
  baseInstruction: string,
  toolMode: ServerConfig["toolMode"],
  preloadedSubagentInstructions: string | undefined,
): string {
  const { workspace } = context;
  const workspaceInstruction = context.workspaceReused
    ? [
        `Workspace already open as ${workspace.id}.`,
        "Continue with this workspace_id.",
        "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
      ].join("\n\n")
    : workspace.mode === "worktree"
      ? "Use this workspace_id for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
      : baseInstruction;
  const legacyReactiveInstruction = toolMode === "claude"
    ? "Long bash commands automatically continue as durable Flyto2 Runtime jobs. Follow any returned @flyto2/job <job_id> command later; do not rerun the original side effect while it is still running."
    : undefined;
  const legacyTaskInstruction = toolMode === "codex"
    ? `If this host still exposes the cached legacy five-tool catalog and background_task is unavailable, create a durable ChatGPT-owned task record with bash command \`${LEGACY_TASK_COMMAND} start <complete task>\`, then continue the work yourself with the normal workspace tools. Runtime stores recovery state only and never delegates the task to Codex, Claude, or another local agent. Use \`${LEGACY_TASK_COMMAND} continue <task_id> <checkpoint>\` to save recovery context and \`${LEGACY_TASK_COMMAND} status <task_id>\` after reconnecting.`
    : undefined;
  const instructionParts = [
    workspaceInstruction,
    legacyReactiveInstruction,
    legacyTaskInstruction,
    ...(preloadedSubagentInstructions && context.includeDiscoveryContext
      ? ["Subagent workflow instructions:", preloadedSubagentInstructions]
      : []),
  ].filter((part): part is string => Boolean(part));

  return instructionParts.join("\n\n");
}

function workspaceResultText(
  context: WorkspaceContext,
  presentation: {
    loadedAgentsFiles: Array<{ path: string; content: string }>;
    availableAgentsFileOutputs: Array<{ path: string }>;
    visibleSkills: Array<{ name: string }>;
    visibleAgentProviders: Array<{
      id: string;
      model?: string;
      effort?: string;
      note?: string;
    }>;
    visibleAgents: Array<{
      name: string;
      provider: string;
      model?: string;
      effort?: string;
    }>;
    instruction: string;
  },
): string {
  const { workspace } = context;
  return [
    context.workspaceReused
      ? `Workspace already open as ${workspace.id}.`
      : workspace.mode === "worktree"
        ? `Opened isolated worktree workspace ${workspace.id}.`
        : `Opened workspace ${workspace.id}.`,
    `Root: ${workspace.root}`,
    `Mode: ${workspace.mode}`,
    presentation.loadedAgentsFiles.length > 0
      ? `Loaded project instructions: ${presentation.loadedAgentsFiles.map((file) => file.path).join(", ")}`
      : undefined,
    presentation.availableAgentsFileOutputs.length > 0
      ? `Available nested instructions: ${presentation.availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
      : undefined,
    presentation.visibleSkills.length > 0
      ? `Available skills: ${presentation.visibleSkills.map((skill) => skill.name).join(", ")}`
      : undefined,
    presentation.visibleAgentProviders.length > 0
      ? `Available subagent providers: ${presentation.visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
      : undefined,
    presentation.visibleAgents.length > 0
      ? `Available subagent profiles: ${presentation.visibleAgents.map(formatVisibleAgent).join(", ")}`
      : undefined,
    presentation.instruction,
  ].filter(Boolean).join("\n");
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const effort = agent.effort ? `, effort ${agent.effort}` : "";
  return `${agent.name} (${agent.provider}${model}${effort})`;
}

function formatAvailableAgentProvider(provider: {
  id: string;
  model?: string;
  effort?: string;
  note?: string;
}): string {
  const details = [
    provider.model ? `model ${provider.model}` : undefined,
    provider.effort ? `effort ${provider.effort}` : undefined,
    provider.note,
  ].filter(Boolean).join(", ");
  return `${provider.id}${details ? ` (${details})` : ""}`;
}

function registerReadTool(options: WorkspaceToolRegistrationOptions): void {
  const { server, config, workspaces } = options;

  server.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description:
        `Read up to ${DEFAULT_READ_LIMIT_LINES} lines of a workspace file. Continue with offset when needed; also use it for instruction or skill paths returned by open_workspace.`,
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path relative to the workspace root, or a skill path returned by open_workspace."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum number of lines to read. Defaults to ${DEFAULT_READ_LIMIT_LINES}.`),
      },
      outputSchema: resultOutputSchema(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, ...input }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const readPath = await workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        {
          ...input,
          path: readPath.absolutePath,
          limit: input.limit ?? DEFAULT_READ_LIMIT_LINES,
        },
        { cwd: workspace.root },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      const result = truncateReadResult(contentText(response.content));
      const content = config.toolMode === "codex"
        ? [textBlock(`Read ${input.path}; full model-readable text is in structuredContent.result.`)]
        : response.content;

      return {
        ...response,
        content,
        structuredContent: {
          result,
        },
      };
    },
  );
}

function truncateReadResult(result: string): string {
  if (result.length <= DEFAULT_READ_MAX_CHARS) return result;

  const available = DEFAULT_READ_MAX_CHARS - READ_TRUNCATION_MARKER.length;
  const tailChars = Math.min(1_000, Math.floor(available / 4));
  const headChars = Math.max(0, available - tailChars);
  return `${result.slice(0, headChars)}${READ_TRUNCATION_MARKER}${result.slice(-tailChars)}`;
}

function registerShowChangesTool(options: WorkspaceToolRegistrationOptions): void {
  const { server, config, workspaces, reviewCheckpoints } = options;

  server.registerTool(
    "show_changes",
    {
      title: "Show changes",
      description:
        "Record and summarize the combined workspace diff. Call once after the final related edit.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        workspace_id: z.string(),
        review_ref: z.string().regex(/^[0-9a-f]{40,64}$/),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }, { _meta }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const reviewRef = typeof _meta?.["devspace/reviewRef"] === "string"
        ? _meta["devspace/reviewRef"]
        : undefined;
      const review = reviewRef
        ? await reviewCheckpoints.reviewByRef({
            workspaceId,
            root: workspace.root,
            reviewRef,
            includePatch: false,
          })
        : await reviewCheckpoints.reviewChanges({
            workspaceId,
            root: workspace.root,
            markReviewed: true,
            includePatch: false,
          });

      const content = [textBlock(review.result)];
      logToolCall(config, {
        tool: "show_changes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        structuredContent: {
          workspace_id: workspaceId,
          review_ref: review.reviewRef,
          result: contentText(content),
        },
      };
    },
  );
}
