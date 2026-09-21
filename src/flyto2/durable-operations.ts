import { createHash } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";

export type DurableOperationStatus = "running" | "completed" | "failed";

export interface DurableOperationRecord {
  operationId: string;
  tool: string;
  fingerprint: string;
  status: DurableOperationStatus;
  response?: unknown;
  error?: { message: string };
  createdAt: string;
  updatedAt: string;
}

export type DurableOperationBeginResult =
  | { mode: "execute"; record: DurableOperationRecord }
  | { mode: "replay"; record: DurableOperationRecord; response: unknown };

const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export class DurableOperationStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  begin(tool: string, operationId: string, payload: unknown): DurableOperationBeginResult {
    validateOperationId(operationId);
    const fingerprint = durableFingerprint({ tool, payload });
    const now = new Date().toISOString();
    const admission = this.database.sqlite
      .prepare(
        `insert into durable_operations (
          operation_id, tool, fingerprint, status, created_at, updated_at
        ) values (?, ?, ?, 'running', ?, ?)
        on conflict(operation_id) do nothing`,
      )
      .run(operationId, tool, fingerprint, now, now);

    if (admission.changes === 1) {
      return {
        mode: "execute",
        record: {
          operationId,
          tool,
          fingerprint,
          status: "running",
          createdAt: now,
          updatedAt: now,
        },
      };
    }

    const existing = this.get(operationId);
    if (!existing) {
      throw new Error("Durable operation admission conflicted but no record could be read.");
    }
    if (existing.fingerprint !== fingerprint) {
      throw new Error("operation_id was already used with different arguments.");
    }
    if (existing.status === "completed") {
      return { mode: "replay", record: existing, response: existing.response };
    }
    if (existing.status === "failed") {
      throw new Error(existing.error?.message ?? "Previous durable operation failed.");
    }
    throw new Error(
      "operation_id already has an in-flight or uncertain side effect; inspect state before using a new operation_id.",
    );
  }

  complete(operationId: string, response: unknown): void {
    const now = new Date().toISOString();
    this.database.sqlite
      .prepare(
        `update durable_operations
         set status = 'completed', response_json = ?, error_json = null, updated_at = ?
         where operation_id = ?`,
      )
      .run(JSON.stringify(response), now, operationId);
  }

  fail(operationId: string, error: unknown): void {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    this.database.sqlite
      .prepare(
        `update durable_operations
         set status = 'failed', error_json = ?, updated_at = ?
         where operation_id = ?`,
      )
      .run(JSON.stringify({ message }), now, operationId);
  }

  get(operationId: string): DurableOperationRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        `select operation_id, tool, fingerprint, status, response_json, error_json,
                created_at, updated_at
         from durable_operations
         where operation_id = ?`,
      )
      .get(operationId) as DurableOperationRow | undefined;

    return row ? durableOperationFromRow(row) : undefined;
  }

  close(): void {
    this.database.close();
  }
}

interface DurableOperationRow {
  operation_id: string;
  tool: string;
  fingerprint: string;
  status: DurableOperationStatus;
  response_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

export async function runDurableOperation<T>(
  store: DurableOperationStore,
  input: {
    tool: string;
    operationId?: string;
    payload: unknown;
  },
  execute: () => Promise<T>,
): Promise<{ replayed: boolean; value: T }> {
  if (!input.operationId) {
    return { replayed: false, value: await execute() };
  }

  const begin = store.begin(input.tool, input.operationId, input.payload);
  if (begin.mode === "replay") {
    return { replayed: true, value: begin.response as T };
  }

  try {
    const value = await execute();
    store.complete(input.operationId, value);
    return { replayed: false, value };
  } catch (error) {
    store.fail(input.operationId, error);
    throw error;
  }
}

export function validateOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error(
      "operation_id must be 8-128 characters using only A-Z a-z 0-9 . _ : -",
    );
  }
}

export function durableFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function durableOperationFromRow(row: DurableOperationRow): DurableOperationRecord {
  return {
    operationId: row.operation_id,
    tool: row.tool,
    fingerprint: row.fingerprint,
    status: row.status,
    response: row.response_json ? JSON.parse(row.response_json) : undefined,
    error: row.error_json ? JSON.parse(row.error_json) as { message: string } : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
