import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-conversation-bindings",
    up: migrateWorkspaceConversationBindings,
  },
  {
    version: 5,
    name: "local-agent-structured-errors",
    up: migrateLocalAgentStructuredErrors,
  },
  {
    version: 6,
    name: "local-agent-effort-rename",
    up: migrateLocalAgentEffortRename,
  },
  {
    version: 7,
    name: "workspace-recovery-state",
    up: migrateWorkspaceRecoveryState,
  },
  {
    version: 8,
    name: "local-agent-turns",
    up: migrateLocalAgentTurns,
  },
  {
    version: 9,
    name: "durable-operations",
    up: migrateDurableOperations,
  },
  {
    version: 10,
    name: "flyto2-runtime-events",
    up: migrateFlyto2RuntimeEvents,
  },
  {
    version: 11,
    name: "flyto2-workspace-watches",
    up: migrateFlyto2WorkspaceWatches,
  },
  {
    version: 12,
    name: "conversation-handoffs",
    up: migrateConversationHandoffs,
  },
  {
    version: 13,
    name: "host-tasks",
    up: migrateHostTasks,
  },
];

export const FLYTO2_STATE_SCHEMA_VERSION =
  migrations.at(-1)?.version ?? 0;

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const appliedRows = sqlite
      .prepare("select version, name from devspace_schema_migrations order by version")
      .all() as Array<{ version: number; name: string }>;
    const migrationsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
    for (const row of appliedRows) {
      const expected = migrationsByVersion.get(row.version);
      if (!expected) {
        throw new Error(
          `Database migration history is incompatible: version ${row.version} (${JSON.stringify(row.name)}) is unknown to this build.`,
        );
      }
      if (row.name !== expected.name) {
        throw new Error(
          `Database migration history is incompatible: version ${row.version} is recorded as ${JSON.stringify(row.name)}, but this build expects ${JSON.stringify(expected.name)}.`,
        );
      }
    }
    const applied = new Set(appliedRows.map((row) => row.version));
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      effort text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
}

function migrateWorkspaceConversationBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}

function migrateLocalAgentStructuredErrors(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_code", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_retryable", "text");
}

function migrateLocalAgentEffortRename(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(local_agent_sessions)").all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  if (names.has("effort")) {
    if (names.has("thinking")) {
      sqlite.exec(`
        update local_agent_sessions
        set effort = thinking
        where effort is null and thinking is not null
      `);
    }
    return;
  }
  if (!names.has("thinking")) {
    addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
    return;
  }
  sqlite.exec("alter table local_agent_sessions rename column thinking to effort");
}

function migrateWorkspaceRecoveryState(sqlite: Database.Database): void {
  const workspaceStateExists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'workspace_sessions'")
    .get();
  if (!workspaceStateExists) return;

  addColumnIfMissing(sqlite, "workspace_sessions", "recovery_kind", "text");
}

function migrateLocalAgentTurns(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_turns (
      id integer primary key autoincrement,
      agent_id text not null,
      prompt text not null,
      status text not null,
      response text,
      error text,
      error_code text,
      error_retryable text,
      created_at text not null,
      completed_at text,
      foreign key (agent_id) references local_agent_sessions(id) on delete cascade
    );

    create index if not exists local_agent_turns_agent_id_idx
      on local_agent_turns(agent_id, id desc);

    create index if not exists local_agent_turns_status_idx
      on local_agent_turns(status);
  `);
}

function migrateDurableOperations(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists durable_operations (
      operation_id text primary key,
      tool text not null,
      fingerprint text not null,
      status text not null,
      response_json text,
      error_json text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists durable_operations_status_idx
      on durable_operations(status, updated_at desc);
  `);
}

function migrateFlyto2RuntimeEvents(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists flyto2_runtime_events (
      sequence integer primary key autoincrement,
      event_id text not null unique,
      type text not null,
      source text not null,
      workspace_id text,
      correlation_id text,
      summary text not null,
      payload_json text not null,
      evidence_json text not null,
      occurred_at text not null
    );

    create index if not exists flyto2_runtime_events_workspace_sequence_idx
      on flyto2_runtime_events(workspace_id, sequence);

    create index if not exists flyto2_runtime_events_type_sequence_idx
      on flyto2_runtime_events(type, sequence);

    create table if not exists flyto2_reactive_jobs (
      id text primary key,
      workspace_id text not null,
      command_digest text not null,
      event_type text not null,
      status text not null,
      evidence_path text not null,
      started_at text not null,
      completed_at text,
      exit_code integer,
      signal text
    );

    create index if not exists flyto2_reactive_jobs_status_idx
      on flyto2_reactive_jobs(status, started_at);
  `);
}

function migrateFlyto2WorkspaceWatches(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists flyto2_workspace_watches (
      id text primary key,
      workspace_id text not null,
      workspace_root text not null,
      canonical_root text not null,
      target_path text not null,
      display_path text not null,
      recursive integer not null,
      event_type text not null,
      debounce_ms integer not null,
      status text not null,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists flyto2_workspace_watches_status_idx
      on flyto2_workspace_watches(status, updated_at);

    create index if not exists flyto2_workspace_watches_workspace_idx
      on flyto2_workspace_watches(workspace_id, status);
  `);
}

function migrateConversationHandoffs(_sqlite: Database.Database): void {
  // Version 12 was shipped before automatic conversation handoffs were removed.
  // Keep the migration identity so existing state remains readable, but do not
  // add unused checkpoint tables to new installations.
}

function migrateHostTasks(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists host_tasks (
      id text primary key,
      workspace_id text not null,
      workspace_root text not null,
      prompt text not null,
      status text not null,
      checkpoint text,
      result text,
      created_at text not null,
      updated_at text not null,
      completed_at text
    );

    create index if not exists host_tasks_workspace_idx
      on host_tasks(workspace_id, status, updated_at desc);
  `);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
