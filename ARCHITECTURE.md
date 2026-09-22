# Flyto2 Runtime architecture

## Product identity

Flyto2 Runtime is the standalone local execution runtime in the Flyto2 project.

It is intentionally useful without Flyto2 Cloud. Direct MCP hosts such as ChatGPT and Claude may connect to the Runtime and use workspaces, file tools, Git/process tools, review checkpoints, and local-agent delegation without any Cloud account or Cloud process.

## Hard boundary: standalone core, optional bridge

The dependency direction is one-way:

```text
MCP host
  |
  v
Flyto2 Runtime core
  |
  +-- optional Flyto2 Cloud bridge ---> Flyto2 Cloud
```

The Runtime core MUST NOT import `flyto-cloud`, Cloud SDK internals, tenant models, billing, War Room state, or hosted persistence.

The optional bridge may depend only on the versioned `flyto2.execution.v1` wire contract and public Cloud device/job APIs.

Flyto2 Cloud MUST NOT depend on Runtime implementation details such as Codex, Claude, worktree paths, process-session IDs, provider session IDs, or local database tables.

## Shared execution contract

`src/flyto2/protocol.ts` owns the Runtime-side TypeScript schema for:

- runtime identity and capability manifest;
- assignments;
- shallow events;
- evidence references;
- completion envelopes.

The wire contract is provider-neutral. Runtime adapters decide how an assignment is executed.

## Standalone surfaces

- MCP server: `src/server.ts`
- workspace lifecycle: `src/workspaces.ts`
- process sessions: `src/process-sessions.ts`
- local agents: `src/local-agent-*.ts`
- durable side effects: `src/durable-operations.ts` + `src/durable-tools.ts`
- capability manifest: `src/flyto2/manifest.ts`

All of these work with the Cloud bridge absent.

## Optional Flyto2 Cloud composition

`src/flyto2/cloud-bridge.ts` maps the Runtime to the existing Flyto2 Cloud paired-device job boundary:

1. consume a one-time pairing code;
2. store the returned device credential in Runtime state with mode 0600;
3. wait on the device job endpoint without involving an LLM polling loop;
4. normalize one Cloud job into a provider-neutral Flyto2 assignment;
5. claim/lease/progress/complete through the existing Cloud job lifecycle.

The bridge does not decide how the assignment runs. That is an executor concern.

## Compatibility with upstream DevSpace

This repository remains a GitHub fork of Waishnav/devspace and keeps the MIT license and upstream history.

Compatibility choices are deliberate:

- `devspace` remains a CLI alias;
- existing `~/.devspace` configuration/state remains valid;
- upstream terminology may remain internally where renaming would create merge churn;
- user-facing identity is Flyto2 Runtime;
- source-native Flyto2 functionality lives in TypeScript, not compiled-JavaScript string patches.

## Event-driven execution

Flyto2 Runtime owns one durable local event stream for standalone MCP use and optional Cloud composition. File mutations performed through durable MCP tools emit shallow workspace events; long non-interactive commands can run through `runtime_run`, which stores bounded evidence locally and emits a completion event. Consumers use a monotonic sequence cursor and one-shot `runtime_wait` instead of model-driven busy polling. Cloud assignment lifecycle events use the same stream and correlation IDs.

Evidence is lazy by design: shallow events contain status, digests and evidence references, never full process output. `runtime_evidence` expands a referenced log only when needed. Runtime restart marks unresolved reactive jobs `orphaned` and explicitly reports the outcome as uncertain rather than replaying the command.

External filesystem changes use persistent native watches rather than polling. Watch specifications are stored in SQLite, targets are canonicalized before persistence, and every restore revalidates the logical workspace root against its original canonical identity. A retargeted symlink/root fails closed with `watch.error` instead of silently observing a different tree. Event batching uses a fixed window so sustained filesystem churn cannot indefinitely postpone wake-up.

## Invariants

1. Cloud is optional.
2. Runtime is independently testable and releasable.
3. The bridge is replaceable.
4. Wire contracts are versioned.
5. Credentials are runtime-only and never committed.
6. Side-effect retries are idempotent through `operation_id`.
7. Cloud orchestration never turns Runtime into a hidden remote shell.
