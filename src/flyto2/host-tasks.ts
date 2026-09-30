import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";

export type HostTaskStatus = "active" | "completed" | "stopped";
export type HostTaskExecutionState =
  | "waiting_for_host"
  | "needs_attention"
  | "completed"
  | "stopped";
export type HostTaskPlanStageStatus = "pending" | "running" | "done" | "blocked";

export interface HostTaskPlanStage {
  title: string;
  status: HostTaskPlanStageStatus;
  summary?: string;
}

export interface HostTaskPlan {
  currentStage: number;
  stages: HostTaskPlanStage[];
}

export interface HostTaskRecord {
  id: string;
  workspaceId: string;
  repoRoot: string;
  workspaceRoot: string;
  prompt: string;
  status: HostTaskStatus;
  plan?: HostTaskPlan;
  checkpoint?: string;
  result?: string;
  attentionReason?: string;
  attentionAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export function hostTaskExecutionState(
  record: HostTaskRecord,
): HostTaskExecutionState {
  if (record.status === "completed") return "completed";
  if (record.status === "stopped") return "stopped";
  if (record.attentionReason) return "needs_attention";
  return "waiting_for_host";
}

interface HostTaskRow {
  id: string;
  workspace_id: string;
  repo_root: string;
  workspace_root: string;
  prompt: string;
  status: HostTaskStatus;
  plan_json: string | null;
  checkpoint: string | null;
  result: string | null;
  attention_reason: string | null;
  attention_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export class HostTaskStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  create(input: {
    workspaceId: string;
    workspaceRoot: string;
    repoRoot?: string;
    prompt: string;
    plan?: HostTaskPlan;
  }): HostTaskRecord {
    const now = new Date().toISOString();
    const record: HostTaskRecord = {
      id: "task_" + randomUUID().replaceAll("-", ""),
      workspaceId: input.workspaceId,
      repoRoot: input.repoRoot ?? input.workspaceRoot,
      workspaceRoot: input.workspaceRoot,
      prompt: input.prompt,
      status: "active",
      plan: input.plan,
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite.prepare(
      `insert into host_tasks (
        id, workspace_id, repo_root, workspace_root, prompt, status, plan_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.workspaceId,
      record.repoRoot,
      record.workspaceRoot,
      record.prompt,
      record.status,
      serializePlan(record.plan),
      record.createdAt,
      record.updatedAt,
    );

    return record;
  }

  get(id: string): HostTaskRecord | undefined {
    const row = this.database.sqlite.prepare(
      `select id, workspace_id, repo_root, workspace_root, prompt, status, plan_json, checkpoint,
              result, attention_reason, attention_at, created_at, updated_at, completed_at
       from host_tasks
       where id = ?`,
    ).get(id) as HostTaskRow | undefined;
    return row ? hostTaskFromRow(row) : undefined;
  }

  findLatestActiveByRoot(workspaceRoot: string): HostTaskRecord | undefined {
    const row = this.database.sqlite.prepare(
      `select id, workspace_id, repo_root, workspace_root, prompt, status, plan_json, checkpoint,
              result, attention_reason, attention_at, created_at, updated_at, completed_at
       from host_tasks
       where workspace_root = ? and status = 'active'
       order by updated_at desc, rowid desc
       limit 1`,
    ).get(workspaceRoot) as HostTaskRow | undefined;
    return row ? hostTaskFromRow(row) : undefined;
  }

  findLatestByRoot(workspaceRoot: string): HostTaskRecord | undefined {
    const row = this.database.sqlite.prepare(
      `select id, workspace_id, repo_root, workspace_root, prompt, status, plan_json, checkpoint,
              result, attention_reason, attention_at, created_at, updated_at, completed_at
       from host_tasks
       where workspace_root = ?
       order by updated_at desc, rowid desc
       limit 1`,
    ).get(workspaceRoot) as HostTaskRow | undefined;
    return row ? hostTaskFromRow(row) : undefined;
  }

  findLatestActiveByRepoRoot(repoRoot: string): HostTaskRecord | undefined {
    const row = this.database.sqlite.prepare(
      `select id, workspace_id, repo_root, workspace_root, prompt, status, plan_json, checkpoint,
              result, attention_reason, attention_at, created_at, updated_at, completed_at
       from host_tasks
       where repo_root = ? and status = 'active'
       order by updated_at desc, rowid desc
       limit 1`,
    ).get(repoRoot) as HostTaskRow | undefined;
    return row ? hostTaskFromRow(row) : undefined;
  }

  findLatestActiveByWorkspaceId(workspaceId: string): HostTaskRecord | undefined {
    const row = this.database.sqlite.prepare(
      `select id, workspace_id, repo_root, workspace_root, prompt, status, plan_json, checkpoint,
              result, attention_reason, attention_at, created_at, updated_at, completed_at
       from host_tasks
       where workspace_id = ? and status = 'active'
       order by updated_at desc
       limit 1`,
    ).get(workspaceId) as HostTaskRow | undefined;
    return row ? hostTaskFromRow(row) : undefined;
  }

  listActiveByWorkspaceId(workspaceId: string): HostTaskRecord[] {
    const rows = this.database.sqlite.prepare(
      `select id, workspace_id, repo_root, workspace_root, prompt, status, plan_json, checkpoint,
              result, attention_reason, attention_at, created_at, updated_at, completed_at
       from host_tasks
       where workspace_id = ? and status = 'active'
       order by updated_at desc`,
    ).all(workspaceId) as HostTaskRow[];
    return rows.map(hostTaskFromRow);
  }

  listActiveByRepoRoot(repoRoot: string): HostTaskRecord[] {
    const rows = this.database.sqlite.prepare(
      `select id, workspace_id, repo_root, workspace_root, prompt, status, plan_json, checkpoint,
              result, attention_reason, attention_at, created_at, updated_at, completed_at
       from host_tasks
       where repo_root = ? and status = 'active'
       order by updated_at desc`,
    ).all(repoRoot) as HostTaskRow[];
    return rows.map(hostTaskFromRow);
  }

  listActive(limit = 128): HostTaskRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 512) {
      throw new Error("Host task list limit must be an integer between 1 and 512.");
    }
    const rows = this.database.sqlite.prepare(
      `select id, workspace_id, repo_root, workspace_root, prompt, status, plan_json, checkpoint,
              result, attention_reason, attention_at, created_at, updated_at, completed_at
       from host_tasks
       where status = 'active'
       order by updated_at desc
       limit ?`,
    ).all(limit) as HostTaskRow[];
    return rows.map(hostTaskFromRow);
  }

  findLatestByRepoRoot(repoRoot: string): HostTaskRecord | undefined {
    const row = this.database.sqlite.prepare(
      `select id, workspace_id, repo_root, workspace_root, prompt, status, plan_json, checkpoint,
              result, attention_reason, attention_at, created_at, updated_at, completed_at
       from host_tasks
       where repo_root = ?
       order by updated_at desc, rowid desc
       limit 1`,
    ).get(repoRoot) as HostTaskRow | undefined;
    return row ? hostTaskFromRow(row) : undefined;
  }

  adoptActive(
    id: string,
    workspaceId: string,
    workspaceRoot: string,
    repoRoot = workspaceRoot,
  ): HostTaskRecord | undefined {
    const now = new Date().toISOString();
    this.database.sqlite.prepare(
      `update host_tasks
       set workspace_id = ?, workspace_root = ?, updated_at = ?
       where id = ? and repo_root = ? and status = 'active'`,
    ).run(workspaceId, workspaceRoot, now, id, repoRoot);
    return this.get(id);
  }

  checkpoint(id: string, checkpoint: string): HostTaskRecord | undefined {
    const now = new Date().toISOString();
    this.database.sqlite.prepare(
      `update host_tasks
       set checkpoint = ?, attention_reason = null, attention_at = null, updated_at = ?
       where id = ? and status = 'active'`,
    ).run(checkpoint, now, id);
    return this.get(id);
  }

  updatePlan(
    id: string,
    input: {
      currentStage?: number;
      stageStatus?: HostTaskPlanStageStatus;
      stageSummary?: string;
    },
  ): HostTaskRecord | undefined {
    const current = this.get(id);
    if (!current || current.status !== "active" || !current.plan) return current;

    const plan = updateTaskPlan(current.plan, input);
    const now = new Date().toISOString();
    this.database.sqlite.prepare(
      `update host_tasks
       set plan_json = ?, attention_reason = null, attention_at = null, updated_at = ?
       where id = ? and status = 'active'`,
    ).run(serializePlan(plan), now, id);
    return this.get(id);
  }

  markNeedsAttention(id: string, reason: string): HostTaskRecord | undefined {
    const normalized = reason.trim();
    if (!normalized) throw new Error("Host task attention reason cannot be empty.");
    const now = new Date().toISOString();
    this.database.sqlite.prepare(
      `update host_tasks
       set attention_reason = ?, attention_at = ?, updated_at = ?
       where id = ? and status = 'active'`,
    ).run(normalized, now, now, id);
    return this.get(id);
  }

  markLatestActiveNeedsAttentionByRepoRoot(
    repoRoot: string,
    reason: string,
  ): HostTaskRecord | undefined {
    const current = this.findLatestActiveByRepoRoot(repoRoot);
    return current ? this.markNeedsAttention(current.id, reason) : undefined;
  }

  complete(id: string, result?: string): HostTaskRecord | undefined {
    const now = new Date().toISOString();
    const current = this.get(id);
    const completedPlan = current?.plan
      ? {
          ...current.plan,
          currentStage: current.plan.stages.length,
          stages: current.plan.stages.map((stage) => ({ ...stage, status: "done" as const })),
        }
      : undefined;
    this.database.sqlite.prepare(
      `update host_tasks
       set status = 'completed', result = ?, plan_json = ?, attention_reason = null,
           attention_at = null, updated_at = ?, completed_at = ?
       where id = ? and status = 'active'`,
    ).run(result ?? null, serializePlan(completedPlan), now, now, id);
    return this.get(id);
  }

  stop(id: string, reason?: string): HostTaskRecord | undefined {
    const now = new Date().toISOString();
    this.database.sqlite.prepare(
      `update host_tasks
       set status = 'stopped', result = ?, attention_reason = null, attention_at = null,
           updated_at = ?, completed_at = ?
       where id = ? and status = 'active'`,
    ).run(reason ?? null, now, now, id);
    return this.get(id);
  }

  close(): void {
    this.database.close();
  }
}

function hostTaskFromRow(row: HostTaskRow): HostTaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repoRoot: row.repo_root,
    workspaceRoot: row.workspace_root,
    prompt: row.prompt,
    status: row.status,
    plan: parsePlan(row.plan_json),
    checkpoint: row.checkpoint ?? undefined,
    result: row.result ?? undefined,
    attentionReason: row.attention_reason ?? undefined,
    attentionAt: row.attention_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function serializePlan(plan: HostTaskPlan | undefined): string | null {
  return plan ? JSON.stringify(plan) : null;
}

function parsePlan(value: string | null): HostTaskPlan | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as {
      currentStage?: unknown;
      stages?: Array<{
        title?: unknown;
        status?: unknown;
        summary?: unknown;
      }>;
    };
    if (!Array.isArray(parsed.stages) || parsed.stages.length === 0) return undefined;
    if (!Number.isInteger(parsed.currentStage) || Number(parsed.currentStage) < 1) return undefined;
    const stages = parsed.stages.flatMap((stage): HostTaskPlanStage[] => {
      if (typeof stage?.title !== "string" || !stage.title.trim()) return [];
      const status = ["pending", "running", "done", "blocked"].includes(String(stage.status))
        ? stage.status as HostTaskPlanStageStatus
        : "pending";
      return [{
        title: stage.title,
        status,
        ...(typeof stage.summary === "string" ? { summary: stage.summary } : {}),
      }];
    });
    if (stages.length === 0) return undefined;
    return {
      currentStage: Math.min(Number(parsed.currentStage), stages.length),
      stages,
    };
  } catch {
    return undefined;
  }
}

function updateTaskPlan(
  current: HostTaskPlan,
  input: {
    currentStage?: number;
    stageStatus?: HostTaskPlanStageStatus;
    stageSummary?: string;
  },
): HostTaskPlan {
  const currentStage = input.currentStage ?? current.currentStage;
  if (currentStage < 1 || currentStage > current.stages.length) return current;

  const stages = current.stages.map((stage, index) => {
    const stageNumber = index + 1;
    if (stageNumber < currentStage && stage.status !== "blocked") {
      return { ...stage, status: "done" as const };
    }
    if (stageNumber !== currentStage) return stage;
    return {
      ...stage,
      status: input.stageStatus ?? "running",
      ...(input.stageSummary !== undefined ? { summary: input.stageSummary } : {}),
    };
  });

  return {
    currentStage,
    stages,
  };
}
