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
- Runtime host lifecycle: `src/cli.ts` + `src/runtime-maintenance.ts`
- Native service, updater, tunnel, and launcher commands: `src/flyto2/operator-cli.ts`
- Optional local-agent CLI: `src/agents-cli.ts`
- portable host plugin packaging: `src/portable-plugin.ts`
- workspace lifecycle: `src/workspaces.ts`
- process sessions: `src/process-sessions.ts`
- local agents: `src/local-agent-*.ts`
- durable side effects: `src/durable-operations.ts` + `src/durable-tools.ts`
- capability manifest: `src/flyto2/manifest.ts`

All of these work with the Cloud bridge absent.

## Process boundaries

`src/server.ts` owns the MCP/HTTP request lifecycle. It does not install services,
restart tunnels, schedule updates, or prune Git worktrees.

`src/cli.ts` binds the listener first. Only after the listener is ready does
`src/runtime-maintenance.ts` start bounded background maintenance: tunnel health
supervision and single-flight stale-worktree cleanup. A slow Git repository or
tunnel check therefore cannot delay `/healthz` or block service recovery.

Administrative commands and local-agent commands are loaded only when invoked.
Normal `serve` startup does not load the updater, desktop launcher, native service
manager, or local-agent command client.

## Optional Flyto2 Cloud composition

`src/flyto2/cloud-bridge.ts` maps the Runtime to the existing Flyto2 Cloud paired-device job boundary:

1. consume a one-time pairing code;
2. store the returned device credential in Runtime state with mode 0600;
3. wait on the device job endpoint without involving an LLM polling loop;
4. normalize one Cloud job into a provider-neutral Flyto2 assignment;
5. claim/lease/progress/complete through the existing Cloud job lifecycle.

The bridge does not decide how the assignment runs. That is an executor concern. When Cloud pairing returns an optional `space_id`, the bridge persists it as opaque credential metadata only; Runtime does not interpret AI Space, MCP routing, tenancy, or War Room state from that value.

## Compatibility with upstream DevSpace

This repository remains a GitHub fork of Waishnav/devspace and keeps the MIT license and upstream history.

Compatibility choices are deliberate:

- `devspace` remains a CLI alias;
- existing `~/.devspace` configuration/state remains valid;
- upstream terminology may remain internally where renaming would create merge churn;
- user-facing identity is Flyto2 Runtime;
- source-native Flyto2 functionality lives in TypeScript, not compiled-JavaScript string patches.

## Event-driven execution

Flyto2 Runtime owns one durable local event stream for standalone MCP use and optional Cloud composition. File mutations emit shallow workspace events. In Codex mode, non-interactive `exec_command` calls automatically enter the durable reactive runner. `process_status` reads that durable process state as an immediate read-only snapshot; `write_stdin` is reserved for interactive PTY input, with a non-blocking compatibility snapshot for older catalogs. Models do not need to orchestrate a separate run/wait/event protocol. Cloud assignment lifecycle events use the same internal stream and correlation IDs.

Evidence is lazy by design: shallow events contain status, digests and evidence references, never full process output. Runtime reads bounded evidence internally when a durable process completes. Runtime restart marks unresolved reactive jobs `orphaned` and explicitly reports the outcome as uncertain rather than replaying the command. Direct manifest/event/evidence/watch MCP tools remain available only when `tools.exposeRuntimeInternals` is explicitly enabled for diagnostics or development.

Durable ChatGPT task recovery is deliberately separate from process execution.
`background_task` stores identity, checkpoints, optional descriptive plan
progress, and explicit completion/stop state. It does not run stage commands,
advance a plan, or infer task completion from local process activity.
When `open_workspace` recovers an active task, it also reports bounded metadata
for any durable process sessions still running against the same canonical
repository. Each recovered process keeps the workspace that originally started
it, so a fresh ChatGPT conversation can inspect that exact session with
`process_status` before deciding whether more execution is necessary. This is
recovery visibility only: Runtime does not attach a process to a task, infer
task ownership from process activity, or auto-resume commands.

Codex-facing command start uses one short event wait so small commands can finish
inline. Once a command becomes durable, status reads never wait: the host can
inspect the durable session only when its next reasoning step depends on the
result. Cached legacy ChatGPT `@flyto2/job` calls translate to the same
immediate snapshot instead of introducing a second polling protocol.

External filesystem changes use persistent native watches rather than polling. Watch specifications are stored in SQLite, targets are canonicalized before persistence, and every restore revalidates the logical workspace root against its original canonical identity. A retargeted symlink/root fails closed with `watch.error` instead of silently observing a different tree. Event batching uses a fixed window so sustained filesystem churn cannot indefinitely postpone wake-up.

## Invariants

1. Cloud is optional.
2. Runtime is independently testable and releasable.
3. The bridge is replaceable.
4. Wire contracts are versioned.
5. Credentials are runtime-only and never committed.
6. Side-effect retries are idempotent through `operation_id`.
7. Cloud orchestration never turns Runtime into a hidden remote shell.
8. Background maintenance never gates listener readiness and never overlaps itself.
