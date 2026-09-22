import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import {
  flyto2EvidenceRefSchema,
  type Flyto2EvidenceRef,
} from "./protocol.js";

const DEFAULT_EVENT_HISTORY = 2_000;
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const MAX_EVENT_SUMMARY_LENGTH = 1_200;
const MAX_WAIT_MS = 25_000;

export interface RuntimeEvent {
  sequence: number;
  event_id: string;
  type: string;
  source: string;
  workspace_id?: string;
  correlation_id?: string;
  summary: string;
  payload: Record<string, unknown>;
  evidence: Flyto2EvidenceRef[];
  occurred_at: string;
}

export interface AppendRuntimeEventInput {
  event_id?: string;
  type: string;
  source: string;
  workspace_id?: string;
  correlation_id?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  evidence?: Flyto2EvidenceRef[];
  occurred_at?: string;
}

export interface RuntimeEventQuery {
  after_sequence?: number;
  workspace_id?: string;
  type?: string;
  correlation_id?: string;
  limit?: number;
}

export interface RuntimeEventWait extends RuntimeEventQuery {
  timeout_ms?: number;
}

interface RuntimeEventRow {
  sequence: number;
  event_id: string;
  type: string;
  source: string;
  workspace_id: string | null;
  correlation_id: string | null;
  summary: string;
  payload_json: string;
  evidence_json: string;
  occurred_at: string;
}

export class RuntimeEventStore {
  private readonly database: DatabaseHandle;
  private readonly emitter = new EventEmitter();

  constructor(
    stateDir: string,
    private readonly maxHistory = DEFAULT_EVENT_HISTORY,
  ) {
    if (!Number.isInteger(maxHistory) || maxHistory < 1) {
      throw new Error("Runtime event history must be a positive integer.");
    }
    this.database = openDatabase(stateDir);
    this.emitter.setMaxListeners(0);
  }

  append(input: AppendRuntimeEventInput): RuntimeEvent {
    const normalized = normalizeEventInput(input);
    const transaction = this.database.sqlite.transaction(() => {
      const admission = this.database.sqlite
        .prepare(
          `insert into flyto2_runtime_events (
            event_id, type, source, workspace_id, correlation_id, summary,
            payload_json, evidence_json, occurred_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(event_id) do nothing`,
        )
        .run(
          normalized.event_id,
          normalized.type,
          normalized.source,
          normalized.workspace_id ?? null,
          normalized.correlation_id ?? null,
          normalized.summary,
          JSON.stringify(normalized.payload),
          JSON.stringify(normalized.evidence),
          normalized.occurred_at,
        );

      const row = this.getById(normalized.event_id);
      if (!row) throw new Error("Runtime event insert did not produce a readable row.");
      if (admission.changes === 0 && !matchesNormalizedEvent(row, normalized)) {
        throw new Error("event_id was already used with different Runtime event content.");
      }
      this.prune();
      return row;
    });

    const event = transaction.immediate();
    this.emitter.emit("event", event.sequence);
    return event;
  }

  list(query: RuntimeEventQuery = {}): RuntimeEvent[] {
    const after = normalizeSequence(query.after_sequence);
    const limit = normalizeLimit(query.limit);
    const clauses = ["sequence > ?"];
    const params: Array<string | number> = [after];

    if (query.workspace_id) {
      clauses.push("workspace_id = ?");
      params.push(query.workspace_id);
    }
    if (query.type) {
      clauses.push("type = ?");
      params.push(query.type);
    }
    if (query.correlation_id) {
      clauses.push("correlation_id = ?");
      params.push(query.correlation_id);
    }

    params.push(limit);
    const rows = this.database.sqlite
      .prepare(
        `select sequence, event_id, type, source, workspace_id, correlation_id,
                summary, payload_json, evidence_json, occurred_at
         from flyto2_runtime_events
         where ${clauses.join(" and ")}
         order by sequence asc
         limit ?`,
      )
      .all(...params) as RuntimeEventRow[];

    return rows.map(runtimeEventFromRow);
  }

  latestSequence(): number {
    const row = this.database.sqlite
      .prepare("select coalesce(max(sequence), 0) as sequence from flyto2_runtime_events")
      .get() as { sequence: number };
    return Number(row.sequence);
  }

  async wait(query: RuntimeEventWait = {}): Promise<RuntimeEvent | undefined> {
    const immediate = this.list({ ...query, limit: 1 })[0];
    if (immediate) return immediate;

    const timeoutMs = normalizeWait(query.timeout_ms);
    if (timeoutMs === 0) return undefined;

    return new Promise<RuntimeEvent | undefined>((resolve) => {
      let settled = false;
      const finish = (event?: RuntimeEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emitter.off("event", onEvent);
        resolve(event);
      };
      const onEvent = () => {
        const event = this.list({ ...query, limit: 1 })[0];
        if (event) finish(event);
      };
      const timer = setTimeout(() => finish(), timeoutMs);
      this.emitter.on("event", onEvent);

      const raced = this.list({ ...query, limit: 1 })[0];
      if (raced) finish(raced);
    });
  }

  close(): void {
    this.emitter.removeAllListeners();
    this.database.close();
  }

  private getById(eventId: string): RuntimeEvent | undefined {
    const row = this.database.sqlite
      .prepare(
        `select sequence, event_id, type, source, workspace_id, correlation_id,
                summary, payload_json, evidence_json, occurred_at
         from flyto2_runtime_events
         where event_id = ?`,
      )
      .get(eventId) as RuntimeEventRow | undefined;
    return row ? runtimeEventFromRow(row) : undefined;
  }

  private prune(): void {
    this.database.sqlite
      .prepare(
        `delete from flyto2_runtime_events
         where sequence <= (
           select coalesce(max(sequence), 0) - ?
           from flyto2_runtime_events
         )`,
      )
      .run(this.maxHistory);
  }
}

function normalizeEventInput(input: AppendRuntimeEventInput): Required<
  Pick<AppendRuntimeEventInput, "event_id" | "type" | "source" | "summary" | "payload" | "evidence" | "occurred_at">
> & Pick<AppendRuntimeEventInput, "workspace_id" | "correlation_id"> {
  const type = boundedToken(input.type, "event type");
  const source = boundedToken(input.source, "event source");
  const summary = (input.summary ?? "").trim();
  if (summary.length > MAX_EVENT_SUMMARY_LENGTH) {
    throw new Error(`Runtime event summary exceeds ${MAX_EVENT_SUMMARY_LENGTH} characters.`);
  }

  const payload = input.payload ?? {};
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error(`Runtime event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes.`);
  }

  const evidence = (input.evidence ?? []).map((entry) => flyto2EvidenceRefSchema.parse(entry));

  return {
    event_id: input.event_id?.trim() || `evt_${randomUUID().replaceAll("-", "")}`,
    type,
    source,
    workspace_id: optionalToken(input.workspace_id, "workspace id"),
    correlation_id: optionalToken(input.correlation_id, "correlation id"),
    summary,
    payload,
    evidence,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
  };
}

function matchesNormalizedEvent(
  event: RuntimeEvent,
  input: ReturnType<typeof normalizeEventInput>,
): boolean {
  return event.event_id === input.event_id
    && event.type === input.type
    && event.source === input.source
    && event.workspace_id === input.workspace_id
    && event.correlation_id === input.correlation_id
    && event.summary === input.summary
    && event.occurred_at === input.occurred_at
    && JSON.stringify(event.payload) === JSON.stringify(input.payload)
    && JSON.stringify(event.evidence) === JSON.stringify(input.evidence);
}

function runtimeEventFromRow(row: RuntimeEventRow): RuntimeEvent {
  return {
    sequence: Number(row.sequence),
    event_id: row.event_id,
    type: row.type,
    source: row.source,
    workspace_id: row.workspace_id ?? undefined,
    correlation_id: row.correlation_id ?? undefined,
    summary: row.summary,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    evidence: JSON.parse(row.evidence_json) as Flyto2EvidenceRef[],
    occurred_at: row.occurred_at,
  };
}

function normalizeSequence(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("after_sequence must be a non-negative safe integer.");
  }
  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("limit must be an integer between 1 and 200.");
  }
  return value;
}

function normalizeWait(value: number | undefined): number {
  if (value === undefined) return MAX_WAIT_MS;
  if (!Number.isInteger(value) || value < 0 || value > MAX_WAIT_MS) {
    throw new Error(`timeout_ms must be an integer between 0 and ${MAX_WAIT_MS}.`);
  }
  return value;
}

function boundedToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw new Error(`${label} must be 1-128 characters.`);
  }
  return normalized;
}

function optionalToken(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  return boundedToken(value, label);
}
