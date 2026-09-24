import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    recoveryKind: text("recovery_kind"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const workspaceConversationBindings = sqliteTable(
  "workspace_conversation_bindings",
  {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_conversation_bindings_workspace_idx").on(table.workspaceSessionId),
  ],
);

export const conversationHandoffs = sqliteTable(
  "conversation_handoffs",
  {
    id: text("id").primaryKey(),
    conversationHash: text("conversation_hash").notNull(),
    workspaceSessionId: text("workspace_session_id"),
    workspaceRoot: text("workspace_root").notNull(),
    taskContext: text("task_context"),
    markdown: text("markdown").notNull(),
    markdownPath: text("markdown_path").notNull(),
    createdAt: text("created_at").notNull(),
    restoredAt: text("restored_at"),
  },
  (table) => [
    index("conversation_handoffs_conversation_idx").on(table.conversationHash, table.createdAt),
    index("conversation_handoffs_workspace_idx").on(table.workspaceSessionId, table.createdAt),
  ],
);

export const conversationBudgetStates = sqliteTable(
  "conversation_budget_states",
  {
    conversationHash: text("conversation_hash").primaryKey(),
    startedAt: text("started_at").notNull(),
    toolCalls: integer("tool_calls").notNull(),
    contextBytes: integer("context_bytes").notNull(),
    workspaceSessionId: text("workspace_session_id"),
    taskContext: text("task_context"),
    recentActivitiesJson: text("recent_activities_json").notNull(),
    handoffId: text("handoff_id"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("conversation_budget_states_updated_idx").on(table.updatedAt),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const durableOperations = sqliteTable(
  "durable_operations",
  {
    operationId: text("operation_id").primaryKey(),
    tool: text("tool").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull(),
    responseJson: text("response_json"),
    errorJson: text("error_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("durable_operations_status_idx").on(table.status, table.updatedAt),
  ],
);

export const flyto2RuntimeEvents = sqliteTable(
  "flyto2_runtime_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull().unique(),
    type: text("type").notNull(),
    source: text("source").notNull(),
    workspaceId: text("workspace_id"),
    correlationId: text("correlation_id"),
    summary: text("summary").notNull(),
    payloadJson: text("payload_json").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [
    index("flyto2_runtime_events_workspace_sequence_idx").on(table.workspaceId, table.sequence),
    index("flyto2_runtime_events_type_sequence_idx").on(table.type, table.sequence),
  ],
);

export const flyto2ReactiveJobs = sqliteTable(
  "flyto2_reactive_jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    commandDigest: text("command_digest").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status").notNull(),
    evidencePath: text("evidence_path").notNull(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    exitCode: integer("exit_code"),
    signal: text("signal"),
  },
  (table) => [
    index("flyto2_reactive_jobs_status_idx").on(table.status, table.startedAt),
  ],
);

export const flyto2WorkspaceWatches = sqliteTable(
  "flyto2_workspace_watches",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    workspaceRoot: text("workspace_root").notNull(),
    canonicalRoot: text("canonical_root").notNull(),
    targetPath: text("target_path").notNull(),
    displayPath: text("display_path").notNull(),
    recursive: integer("recursive").notNull(),
    eventType: text("event_type").notNull(),
    debounceMs: integer("debounce_ms").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("flyto2_workspace_watches_status_idx").on(table.status, table.updatedAt),
    index("flyto2_workspace_watches_workspace_idx").on(table.workspaceId, table.status),
  ],
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    effort: text("effort"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    errorCode: text("error_code"),
    errorRetryable: text("error_retryable"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export type Flyto2RuntimeEventRow = typeof flyto2RuntimeEvents.$inferSelect;
export type NewFlyto2RuntimeEventRow = typeof flyto2RuntimeEvents.$inferInsert;
export type Flyto2ReactiveJobRow = typeof flyto2ReactiveJobs.$inferSelect;
export type NewFlyto2ReactiveJobRow = typeof flyto2ReactiveJobs.$inferInsert;
export type Flyto2WorkspaceWatchRow = typeof flyto2WorkspaceWatches.$inferSelect;
export type NewFlyto2WorkspaceWatchRow = typeof flyto2WorkspaceWatches.$inferInsert;
export type DurableOperationRow = typeof durableOperations.$inferSelect;
export type NewDurableOperationRow = typeof durableOperations.$inferInsert;
export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type WorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferSelect;
export type NewWorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
