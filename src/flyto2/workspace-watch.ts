import { randomUUID } from "node:crypto";
import {
  existsSync,
  watch as fsWatch,
  realpathSync,
  statSync,
  type FSWatcher,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import type { RuntimeEventStore } from "./runtime-events.js";

const DEFAULT_DEBOUNCE_MS = 120;
const MIN_DEBOUNCE_MS = 20;
const MAX_DEBOUNCE_MS = 2_000;
const MAX_BATCH_CHANGES = 128;

export interface WorkspaceWatchInput {
  workspace_id: string;
  workspace_root: string;
  canonical_root: string;
  target_path: string;
  display_path: string;
  recursive?: boolean;
  event_type?: string;
  debounce_ms?: number;
}

export interface WorkspaceWatchRecord {
  watch_id: string;
  workspace_id: string;
  path: string;
  recursive: boolean;
  event_type: string;
  debounce_ms: number;
  status: "active" | "stopped" | "error";
  created_at: string;
  updated_at: string;
}

interface WorkspaceWatchRow {
  id: string;
  workspace_id: string;
  workspace_root: string;
  canonical_root: string;
  target_path: string;
  display_path: string;
  recursive: number;
  event_type: string;
  debounce_ms: number;
  status: WorkspaceWatchRecord["status"];
  created_at: string;
  updated_at: string;
}

interface ActiveWatch {
  row: WorkspaceWatchRow;
  watcher: FSWatcher;
  pending: Map<string, "rename" | "change">;
  timer?: NodeJS.Timeout;
}

export class WorkspaceWatchRegistry {
  private readonly database: DatabaseHandle;
  private readonly active = new Map<string, ActiveWatch>();
  private closed = false;

  constructor(
    stateDir: string,
    private readonly events: RuntimeEventStore,
  ) {
    this.database = openDatabase(stateDir);
    this.restoreActiveWatches();
  }

  start(input: WorkspaceWatchInput): WorkspaceWatchRecord {
    if (this.closed) throw new Error("Workspace watch registry is closed.");

    const canonicalRoot = resolve(input.canonical_root);
    assertRootIdentity(input.workspace_root, canonicalRoot);
    const targetPath = canonicalWatchTarget(input.target_path, canonicalRoot);

    const recursive = input.recursive ?? statSync(targetPath).isDirectory();
    const eventType = normalizeEventType(input.event_type);
    const debounceMs = normalizeDebounce(input.debounce_ms);
    const now = new Date().toISOString();
    const row: WorkspaceWatchRow = {
      id: `watch_${randomUUID().replaceAll("-", "")}`,
      workspace_id: input.workspace_id,
      workspace_root: input.workspace_root,
      canonical_root: canonicalRoot,
      target_path: targetPath,
      display_path: normalizeDisplayPath(input.display_path),
      recursive: recursive ? 1 : 0,
      event_type: eventType,
      debounce_ms: debounceMs,
      status: "active",
      created_at: now,
      updated_at: now,
    };

    this.database.sqlite
      .prepare(
        `insert into flyto2_workspace_watches (
          id, workspace_id, workspace_root, canonical_root, target_path,
          display_path, recursive, event_type, debounce_ms, status,
          created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        row.id,
        row.workspace_id,
        row.workspace_root,
        row.canonical_root,
        row.target_path,
        row.display_path,
        row.recursive,
        row.event_type,
        row.debounce_ms,
        row.created_at,
        row.updated_at,
      );

    try {
      this.install(row);
    } catch (error) {
      this.updateStatus(row.id, "error");
      throw error;
    }

    this.events.append({
      type: "watch.started",
      source: "fs.watch",
      workspace_id: row.workspace_id,
      correlation_id: row.id,
      summary: "Workspace filesystem watch started.",
      payload: {
        watch_id: row.id,
        path: row.display_path,
        recursive: Boolean(row.recursive),
        event_type: row.event_type,
      },
    });

    return watchRecordFromRow(row);
  }

  stop(watchId: string): WorkspaceWatchRecord {
    const row = this.getRow(watchId);
    if (!row) throw new Error(`Unknown workspace watch: ${watchId}`);

    this.closeActive(watchId);
    const updatedAt = new Date().toISOString();
    this.database.sqlite
      .prepare(
        "update flyto2_workspace_watches set status = 'stopped', updated_at = ? where id = ?",
      )
      .run(updatedAt, watchId);
    const stopped = { ...row, status: "stopped" as const, updated_at: updatedAt };

    this.events.append({
      type: "watch.stopped",
      source: "fs.watch",
      workspace_id: row.workspace_id,
      correlation_id: row.id,
      summary: "Workspace filesystem watch stopped.",
      payload: {
        watch_id: row.id,
        path: row.display_path,
      },
    });

    return watchRecordFromRow(stopped);
  }

  list(workspaceId?: string): WorkspaceWatchRecord[] {
    const rows = workspaceId
      ? this.database.sqlite
          .prepare(
            `select id, workspace_id, workspace_root, canonical_root, target_path,
                    display_path, recursive, event_type, debounce_ms, status,
                    created_at, updated_at
             from flyto2_workspace_watches
             where workspace_id = ?
             order by created_at asc`,
          )
          .all(workspaceId)
      : this.database.sqlite
          .prepare(
            `select id, workspace_id, workspace_root, canonical_root, target_path,
                    display_path, recursive, event_type, debounce_ms, status,
                    created_at, updated_at
             from flyto2_workspace_watches
             order by created_at asc`,
          )
          .all();

    return (rows as WorkspaceWatchRow[]).map(watchRecordFromRow);
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const watchId of Array.from(this.active.keys())) {
      this.closeActive(watchId);
    }
    this.database.close();
  }

  private restoreActiveWatches(): void {
    const rows = this.database.sqlite
      .prepare(
        `select id, workspace_id, workspace_root, canonical_root, target_path,
                display_path, recursive, event_type, debounce_ms, status,
                created_at, updated_at
         from flyto2_workspace_watches
         where status = 'active'
         order by created_at asc`,
      )
      .all() as WorkspaceWatchRow[];

    for (const row of rows) {
      try {
        assertRootIdentity(row.workspace_root, row.canonical_root);
        const canonicalTarget = canonicalWatchTarget(
          row.target_path,
          row.canonical_root,
        );
        if (canonicalTarget !== row.target_path) {
          row.target_path = canonicalTarget;
          this.database.sqlite
            .prepare(
              "update flyto2_workspace_watches set target_path = ?, updated_at = ? where id = ?",
            )
            .run(canonicalTarget, new Date().toISOString(), row.id);
        }
        this.install(row);
      } catch (error) {
        this.updateStatus(row.id, "error");
        this.events.append({
          event_id: `evt_watch_restore_error_${row.id}`,
          type: "watch.error",
          source: "fs.watch",
          workspace_id: row.workspace_id,
          correlation_id: row.id,
          summary: "Persisted workspace watch could not be restored.",
          payload: {
            watch_id: row.id,
            path: row.display_path,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  private install(row: WorkspaceWatchRow): void {
    const targetIsDirectory = statSync(row.target_path).isDirectory();
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(
        row.target_path,
        {
          persistent: false,
          recursive: Boolean(row.recursive) && targetIsDirectory,
          encoding: "utf8",
        },
        (eventType, filename) => {
          this.recordChange(row.id, eventType, filename?.toString());
        },
      );
    } catch (error) {
      throw new Error(
        `Unable to watch ${row.display_path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    watcher.on("error", (error) => this.failWatch(row.id, error));
    this.active.set(row.id, {
      row,
      watcher,
      pending: new Map(),
    });
  }

  private recordChange(
    watchId: string,
    eventType: "rename" | "change",
    filename?: string,
  ): void {
    const active = this.active.get(watchId);
    if (!active || this.closed) return;

    const relativePath = this.relativeChangedPath(active.row, filename);
    if (!relativePath) return;
    active.pending.set(relativePath, eventType);

    if (!active.timer) {
      active.timer = setTimeout(
        () => this.flush(active.row.id),
        active.row.debounce_ms,
      );
      active.timer.unref();
    }
  }

  private flush(watchId: string): void {
    const active = this.active.get(watchId);
    if (!active || active.pending.size === 0 || this.closed) return;

    const allChanges = Array.from(active.pending.entries())
      .map(([path, event]) => ({ path, event }))
      .sort((left, right) => left.path.localeCompare(right.path));
    active.pending.clear();
    active.timer = undefined;

    const truncated = allChanges.length > MAX_BATCH_CHANGES;
    const changes = allChanges.slice(0, MAX_BATCH_CHANGES);
    this.events.append({
      type: active.row.event_type,
      source: "fs.watch",
      workspace_id: active.row.workspace_id,
      correlation_id: active.row.id,
      summary:
        changes.length === 1
          ? `External workspace change: ${changes[0]!.path}`
          : `External workspace changes: ${changes.length}${truncated ? "+" : ""} paths.`,
      payload: {
        watch_id: active.row.id,
        watched_path: active.row.display_path,
        recursive: Boolean(active.row.recursive),
        changes,
        truncated,
      },
    });
  }

  private relativeChangedPath(
    row: WorkspaceWatchRow,
    filename?: string,
  ): string | undefined {
    const targetIsDirectory = existsSync(row.target_path)
      ? statSync(row.target_path).isDirectory()
      : false;
    if (!targetIsDirectory || !filename) return row.display_path;

    const changed = resolve(row.target_path, filename);
    if (!isPathInside(changed, row.canonical_root)) return undefined;
    const workspaceRelative = relative(row.canonical_root, changed);
    return workspaceRelative || ".";
  }

  private failWatch(watchId: string, error: unknown): void {
    const active = this.active.get(watchId);
    const row = active?.row ?? this.getRow(watchId);
    if (!row) return;

    this.closeActive(watchId);
    this.updateStatus(watchId, "error");
    this.events.append({
      type: "watch.error",
      source: "fs.watch",
      workspace_id: row.workspace_id,
      correlation_id: row.id,
      summary: "Workspace filesystem watch failed.",
      payload: {
        watch_id: row.id,
        path: row.display_path,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }

  private closeActive(watchId: string): void {
    const active = this.active.get(watchId);
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.watcher.close();
    this.active.delete(watchId);
  }

  private updateStatus(
    watchId: string,
    status: WorkspaceWatchRecord["status"],
  ): void {
    this.database.sqlite
      .prepare(
        "update flyto2_workspace_watches set status = ?, updated_at = ? where id = ?",
      )
      .run(status, new Date().toISOString(), watchId);
  }

  private getRow(watchId: string): WorkspaceWatchRow | undefined {
    return this.database.sqlite
      .prepare(
        `select id, workspace_id, workspace_root, canonical_root, target_path,
                display_path, recursive, event_type, debounce_ms, status,
                created_at, updated_at
         from flyto2_workspace_watches
         where id = ?`,
      )
      .get(watchId) as WorkspaceWatchRow | undefined;
  }
}

function assertRootIdentity(
  workspaceRoot: string,
  canonicalRoot: string,
): void {
  if (!existsSync(workspaceRoot)) {
    throw new Error(`Workspace root no longer exists: ${workspaceRoot}`);
  }
  const currentCanonical = realpathSync(workspaceRoot);
  if (resolve(currentCanonical) !== resolve(canonicalRoot)) {
    throw new Error("Workspace root canonical identity changed; refusing to restore filesystem watch.");
  }
}

function canonicalWatchTarget(
  targetPath: string,
  canonicalRoot: string,
): string {
  if (!existsSync(targetPath)) {
    throw new Error(`Watch target does not exist: ${targetPath}`);
  }
  const canonicalTarget = realpathSync(targetPath);
  if (!isPathInside(canonicalTarget, canonicalRoot)) {
    throw new Error("Watch target escapes the workspace canonical root.");
  }
  return canonicalTarget;
}

function isPathInside(path: string, root: string): boolean {
  const relationship = relative(resolve(root), resolve(path));
  return relationship === ""
    || (!relationship.startsWith("..") && relationship !== ".." && !relationship.startsWith(`..${sep}`));
}

function normalizeDisplayPath(value: string): string {
  const normalized = value.trim() || ".";
  return normalized.replaceAll("\\", "/");
}

function normalizeDebounce(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DEBOUNCE_MS;
  if (
    !Number.isInteger(value)
    || value < MIN_DEBOUNCE_MS
    || value > MAX_DEBOUNCE_MS
  ) {
    throw new Error(
      `debounce_ms must be an integer between ${MIN_DEBOUNCE_MS} and ${MAX_DEBOUNCE_MS}.`,
    );
  }
  return value;
}

function normalizeEventType(value: string | undefined): string {
  const eventType = value?.trim() || "file.changed";
  if (!eventType || eventType.length > 128) {
    throw new Error("event_type must be 1-128 characters.");
  }
  return eventType;
}

function watchRecordFromRow(row: WorkspaceWatchRow): WorkspaceWatchRecord {
  return {
    watch_id: row.id,
    workspace_id: row.workspace_id,
    path: row.display_path,
    recursive: Boolean(row.recursive),
    event_type: row.event_type,
    debounce_ms: row.debounce_ms,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
