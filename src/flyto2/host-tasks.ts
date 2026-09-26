import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";

export type HostTaskStatus = "active" | "completed" | "stopped";
export type HostTaskPlanStageStatus = "pending" | "running" | "done" | "blocked";

export interface HostTaskPlanStage {
  title: string;
  status: HostTaskPlanStageStatus;
  summary?: string;
  command?: string;
  timeoutSeconds?: number;
  evidenceRef?: string;
}

export interface HostTaskPlan {
  currentStage: number;
  autoRun?: boolean;
  activeSessionId?: string;
  activeJobId?: string;
  stages: HostTaskPlanStage[];
}

export interface HostTaskRecord {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  prompt: string;
  status: HostTaskStatus;
  plan?: HostTaskPlan;
  checkpoint?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface HostTaskRow {
  id: string;
  workspace_id: string;
  workspace_root: string;
  prompt: string;
  status: HostTaskStatus;
  plan_json: string | null;
  checkpoint: string | null;
  result: string | null;
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
    prompt: string;
    plan?: HostTaskPlan;
  }): HostTaskRecord {
    const now = new Date().toISOString();
    const record: HostTaskRecord = {
      id: "task_" + randomUUID().replaceAll("-", ""),
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      prompt: input.prompt,
      status: "active",
      plan: input.plan,
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite.prepare(
      `insert into host_tasks (
        id, workspace_id, workspace_root, prompt, status, plan_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.workspaceId,
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
      `select id, workspace_id, workspace_root, prompt, status, plan_json, checkpoint,
              result, created_at, updated_at, completed_at
       from host_tasks
       where id = ?`,
    ).get(id) as HostTaskRow | undefined;
    return row ? hostTaskFromRow(row) : undefined;
  }

  findLatestActiveByRoot(workspaceRoot: string): HostTaskRecord | undefined {
    const row = this.database.sqlite.prepare(
      `select id, workspace_id, workspace_root, prompt, status, plan_json, checkpoint,
              result, created_at, updated_at, completed_at
       from host_tasks
       where workspace_root = ? and status = 'active'
       order by updated_at desc, rowid desc
       limit 1`,
    ).get(workspaceRoot) as HostTaskRow | undefined;
    return row ? hostTaskFromRow(row) : undefined;
  }

  findLatestByRoot(workspaceRoot: string): HostTaskRecord | undefined {
    const row = this.database.sqlite.prepare(
      `select id, workspace_id, workspace_root, prompt, status, plan_json, checkpoint,
              result, created_at, updated_at, completed_at
       from host_tasks
       where workspace_root = ?
       order by updated_at desc, rowid desc
       limit 1`,
    ).get(workspaceRoot) as HostTaskRow | undefined;
    return row ? hostTaskFromRow(row) : undefined;
  }

  listActiveWithPlans(): HostTaskRecord[] {
    const rows = this.database.sqlite.prepare(
      `select id, workspace_id, workspace_root, prompt, status, plan_json, checkpoint,
              result, created_at, updated_at, completed_at
       from host_tasks
       where status = 'active' and plan_json is not null
       order by updated_at asc, rowid asc`,
    ).all() as HostTaskRow[];
    return rows.map(hostTaskFromRow).filter((record) => record.plan !== undefined);
  }

  findActiveByJobId(jobId: string): HostTaskRecord | undefined {
    return this.listActiveWithPlans().find((record) => record.plan?.activeJobId === jobId);
  }

  adoptActive(
    id: string,
    workspaceId: string,
    workspaceRoot: string,
  ): HostTaskRecord | undefined {
    const now = new Date().toISOString();
    this.database.sqlite.prepare(
      `update host_tasks
       set workspace_id = ?, updated_at = ?
       where id = ? and workspace_root = ? and status = 'active'`,
    ).run(workspaceId, now, id, workspaceRoot);
    return this.get(id);
  }

  checkpoint(id: string, checkpoint: string): HostTaskRecord | undefined {
    const now = new Date().toISOString();
    this.database.sqlite.prepare(
      `update host_tasks
       set checkpoint = ?, updated_at = ?
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
      activeSessionId?: string;
      activeJobId?: string | null;
      evidenceRef?: string;
      autoRun?: boolean;
    },
  ): HostTaskRecord | undefined {
    const current = this.get(id);
    if (!current || current.status !== "active" || !current.plan) return current;

    const plan = updateTaskPlan(current.plan, input);
    const now = new Date().toISOString();
    this.database.sqlite.prepare(
      `update host_tasks
       set plan_json = ?, updated_at = ?
       where id = ? and status = 'active'`,
    ).run(serializePlan(plan), now, id);
    return this.get(id);
  }

  complete(id: string, result?: string): HostTaskRecord | undefined {
    const now = new Date().toISOString();
    const current = this.get(id);
    const completedPlan = current?.plan
      ? {
          ...current.plan,
          activeSessionId: undefined,
          activeJobId: undefined,
          currentStage: current.plan.stages.length,
          stages: current.plan.stages.map((stage) => ({ ...stage, status: "done" as const })),
        }
      : undefined;
    this.database.sqlite.prepare(
      `update host_tasks
       set status = 'completed', result = ?, plan_json = ?, updated_at = ?, completed_at = ?
       where id = ? and status = 'active'`,
    ).run(result ?? null, serializePlan(completedPlan), now, now, id);
    return this.get(id);
  }

  stop(id: string, reason?: string): HostTaskRecord | undefined {
    const now = new Date().toISOString();
    this.database.sqlite.prepare(
      `update host_tasks
       set status = 'stopped', result = ?, updated_at = ?, completed_at = ?
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
    workspaceRoot: row.workspace_root,
    prompt: row.prompt,
    status: row.status,
    plan: parsePlan(row.plan_json),
    checkpoint: row.checkpoint ?? undefined,
    result: row.result ?? undefined,
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
    const parsed = JSON.parse(value) as HostTaskPlan;
    if (!Array.isArray(parsed.stages) || parsed.stages.length === 0) return undefined;
    if (!Number.isInteger(parsed.currentStage) || parsed.currentStage < 1) return undefined;
    return parsed;
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
    activeSessionId?: string;
    activeJobId?: string | null;
    evidenceRef?: string;
    autoRun?: boolean;
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
      ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef } : {}),
    };
  });
  const stageStatus = stages[currentStage - 1]?.status;
  const movedStage = currentStage !== current.currentStage;
  const shouldClearSession = movedStage || stageStatus === "done" || stageStatus === "blocked";

  return {
    currentStage,
    autoRun: input.autoRun ?? current.autoRun,
    stages,
    activeSessionId: input.activeSessionId ?? (shouldClearSession ? undefined : current.activeSessionId),
    activeJobId: input.activeJobId === null
      ? undefined
      : input.activeJobId ?? (shouldClearSession ? undefined : current.activeJobId),
  };
}
