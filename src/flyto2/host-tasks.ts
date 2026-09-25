import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";

export type HostTaskStatus = "active" | "completed" | "stopped";

export interface HostTaskRecord {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  prompt: string;
  status: HostTaskStatus;
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
  }): HostTaskRecord {
    const now = new Date().toISOString();
    const record: HostTaskRecord = {
      id: "task_" + randomUUID().replaceAll("-", ""),
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      prompt: input.prompt,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite.prepare(
      `insert into host_tasks (
        id, workspace_id, workspace_root, prompt, status, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.workspaceId,
      record.workspaceRoot,
      record.prompt,
      record.status,
      record.createdAt,
      record.updatedAt,
    );

    return record;
  }

  get(id: string): HostTaskRecord | undefined {
    const row = this.database.sqlite.prepare(
      `select id, workspace_id, workspace_root, prompt, status, checkpoint,
              result, created_at, updated_at, completed_at
       from host_tasks
       where id = ?`,
    ).get(id) as HostTaskRow | undefined;
    return row ? hostTaskFromRow(row) : undefined;
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

  complete(id: string, result?: string): HostTaskRecord | undefined {
    const now = new Date().toISOString();
    this.database.sqlite.prepare(
      `update host_tasks
       set status = 'completed', result = ?, updated_at = ?, completed_at = ?
       where id = ? and status = 'active'`,
    ).run(result ?? null, now, now, id);
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
    checkpoint: row.checkpoint ?? undefined,
    result: row.result ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}
