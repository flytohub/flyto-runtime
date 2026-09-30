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

### Capability provider boundary

Runtime capabilities have three deliberately separate layers:

```text
flyto2.execution.v1 contract
          |
          v
capability catalog + provider registry
          |
          v
workspace / file / process / Git / agent adapters
```

`src/flyto2/capability-catalog.ts` is the canonical declaration surface for
Runtime capability ids, revisions, risk levels, approval requirements, and
expected evidence kinds. The Runtime manifest is generated from that catalog.

`src/flyto2/capability-provider.ts` is the stable execution seam. A provider
must match an existing catalog descriptor exactly before it can register. The
registry accepts provider-neutral invocation envelopes and returns
provider-neutral result envelopes; it does not expose local path resolution,
process-session ids, Git implementation details, or SQLite state.

`src/flyto2/capability-audit.ts` maps shallow invocation lifecycle metadata to
the existing durable Runtime event stream. Capability audit events contain
identity, operation, timing, failure, and evidence references, but deliberately
exclude raw invocation input and output so credentials/source content do not
become audit-log payloads by default.

Existing MCP tools remain the production execution path while adapters are
migrated capability-by-capability. Do not perform a flag-day rewrite. A
capability moves behind the registry only after its existing behavior has a
focused adapter and regression coverage.

Long-running capability admission is distinct from terminal success. An
accepted invocation returns an opaque operation handle and shallow evidence;
the caller may inspect that handle through a read-only status capability or the
Runtime event stream. The provider registry never waits on behalf of Core or
Cloud and never interprets `accepted` as successful task completion.

Accepted operation handles may include self-describing `wait` and `inspect`
follow-ups. These are capability names plus provider-neutral input, not direct
references to Runtime classes or storage. This lets Core/Cloud follow a durable
operation through `event.wait`, `process.status`, and policy-gated
`evidence.read` without learning job-table or filesystem details.

### Capability transport seam

`src/flyto2/capability-transport.ts` is deliberately smaller than any product
integration. It exposes only the live manifest and versioned capability
invocation/result envelopes. It does not import Flyto2 Cloud, workspace
implementations, Git, process runners, or storage.

Optional product adapters sit outside that seam. The Cloud capability
assignment adapter translates a Cloud assignment into a capability invocation,
uses self-describing wait follow-ups for accepted operations, and replays the
same original `operation_id` after the terminal event. It does not start a
second workflow engine and is not enabled merely by booting standalone Runtime.
Core can consume the same transport contract without using the Cloud adapter.

The wire contract is also published as draft-2020-12 JSON Schema under
`schema/flyto2.execution.v1/`. Those generated artifacts, not TypeScript source
imports, are the interoperability boundary for another language or repository.
Checked-in fixtures are validated against the same Zod source in CI to detect
schema drift while keeping example payloads free of local paths and secrets.

The first migrated provider set is deliberately read-oriented:
`workspace.open` (checkout only), `source.read`, `git.inspect`, and
`review.diff`. `workspace.open` does not create an isolated worktree through
this provider; worktree creation remains a separate future side-effecting
capability. When a caller supplies a `trace_id`, repeated checkout opens in that
trace reuse the same Runtime workspace. Opening the workspace establishes an
internal Git-backed review checkpoint so later diffs are relative to open time,
but it does not modify the checked-out files or expose local roots. `review.diff`
never advances the MCP `show_changes` baseline.
The normal MCP surface remains unchanged and may share lower-level helpers with
providers so path containment and read semantics have one implementation.

Side-effecting providers must preserve Runtime's existing `operation_id`
admission/replay guarantee before they are exposed through this seam. The
provider registry is not a replacement for `DurableOperationStore`; it is the
stable capability boundary above that durability layer. This keeps retries
auditable without creating a second execution engine.

This makes the boundary extractable in either direction:

- **Flyto2 Core** may compose a Runtime capability through the versioned
  invocation/result contract without importing Runtime implementation code.
- **Flyto2 Cloud** may discover/route Runtime capability ids through the
  manifest and paired-device assignment boundary without knowing local
  workspace/process/database internals.
- **Flyto2 Runtime** remains independently installable and keeps machine-local
  authority, credentials, process lifecycle, and filesystem admission.

Runtime provider registration is grouped into explicit capability bundles:
`read`, `execution`, `mutation`, `observability`, and optional `agent`. The
standalone server selects its core profile explicitly and adds `agent` only when
subagents are configured. Core/Cloud composition may select any subset without
initializing unrelated providers. Bundle names are a Runtime composition detail;
the cross-product wire contract continues to expose only concrete capability
descriptors.

The agent bundle is an adapter over Runtime's existing local-agent daemon and
durable agent-session store. It never embeds provider SDKs, credentials, or
provider session identifiers in `flyto2.execution.v1`. Delegation/continuation
are explicit-approval side effects protected by `operation_id`; observation is
workspace-scoped through `agent.inspect` / bounded `agent.wait`. The agent
adapter does not plan multi-step work and is not a second workflow engine.

Cross-process local composition uses the Runtime-owned localhost capability
bridge. The bridge exposes only the live capability manifest and
`flyto2.execution.v1` invocation/result envelopes and delegates directly to the
same `Flyto2CapabilityTransport` used in-process. It is authenticated with a
persistent same-user token and requires both a loopback socket peer and loopback
Host header, preventing the public MCP/tunnel URL from becoming a direct machine
execution endpoint. Core therefore communicates over the wire contract rather
than importing Runtime providers, state stores, or TypeScript types.

### Runtime operational model

`src/flyto2/operational-model.ts` is the canonical vocabulary for Runtime
operational state. It defines task execution projection, process/operation/
callback state families, allowed Host Task terminal transitions, stable reason
codes, coarse diagnostic phases, suggested actions, confidence values, and the
cross-subsystem correlation envelope. Storage implementations still own their
durable records; this model does not create another state store or workflow
engine.

Task, process, durable operation, and callback delivery deliberately remain
different state machines. They are correlated rather than collapsed into one
ambiguous `running` flag. New Runtime events carry a canonical correlation
envelope (`task_id`, `workspace_id`, `process_session_id`, `operation_id`,
`invocation_id`, `event_id`). Older persisted events are projected into the same
envelope from their established top-level/payload identifiers, so upgrades do
not invalidate recovery history.

`task-diagnostics.ts` is the canonical read projection over those durable
states and events. It consumes the operational model instead of redefining
state/reason/phase rules and returns the bounded diagnosis used by
`background_task status` and `open_workspace` recovery.

### Event-driven long-task continuation

Long-running processes are not kept alive by a ChatGPT response stream. Runtime
owns the process session and evidence while the host remains the task owner.
Meaningful state changes are projected into generic Runtime events:

- `process.completed`
- `process.failed`
- `process.stalled`
- `task.needs_attention`

The authenticated `/mcp` endpoint implements the ChatGPT MCP Events draft for
event discovery, subscription, unsubscribe, callback verification, and webhook
delivery. Subscription state is persistent. Deliveries use Standard Webhooks
HMAC signatures and a DNS-pinned HTTPS connection after public-address
validation; redirects are not followed.

Events are advisory continuation signals, not a replacement for durable state.
When a process fails or becomes orphaned, the owning Host Task is reconciled to
`needs_attention` without being auto-completed. On startup, Runtime repairs stale
active tasks whose latest owning process already failed. If an event callback is
missed, `open_workspace` exposes the attention reason and process recovery data
so ChatGPT can resume from evidence rather than rerunning the failed command.

### Long-task diagnostic projection

`src/flyto2/task-diagnostics.ts` projects existing durable state into a bounded
debugging view; it is not another execution or workflow engine. The projection
combines the Host Task, latest owning process, shallow Runtime events, MCP event
delivery diagnostics, and correlation identifiers into:

- a stable reason code;
- a coarse execution phase such as test/build/git/command/callback wait;
- the latest process activity snapshot;
- a bounded chronological timeline;
- task/workspace/process/operation/invocation/event correlation IDs;
- one recovery-oriented suggested action.

Task lifecycle updates and process lifecycle projections are emitted as shallow
events without prompt text, source content, command output, callback URLs, or
signing secrets. Full evidence remains local and lazy. Diagnostics therefore
answer where continuation broke while keeping the event stream suitable for
audit and recovery.

The Runtime composition root also keeps provider modules optional. Read-only,
durable execution, and local mutation modules may be enabled independently.
Core or Cloud integration never changes which lower-level Runtime modules are
required to boot; it only consumes capabilities that the manifest/registry says
are actually registered.

The catalog and live manifest have intentionally different meanings. The
catalog is the build-time vocabulary of capabilities Runtime understands; the
live manifest is generated from the registry's actually registered providers.
Never advertise a catalog capability in a running instance when its provider
module is not loaded.

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
9. Capability ids/revisions/risk/approval/evidence metadata have one canonical catalog.
10. Core and Cloud compose Runtime through versioned contracts, never by importing Runtime internals.
11. Capability audit records are shallow by default; source text, command output, and secrets stay in bounded evidence stores or the local execution surface.
12. Capability migration is incremental; the provider registry must not become a second hidden workflow engine.
13. Side-effecting capability providers retain exactly-once `operation_id` admission/replay below the provider seam.
14. Long-running capabilities report `accepted` separately from terminal success/failure and reuse Runtime durable process state.
15. Mutation capability modules are optional; Runtime can boot and operate read-only without them.
16. `git.mutate` remains local-only at this boundary and must not grow implicit push/reset/clean/checkout behavior.
17. A live Runtime manifest advertises registered providers, never the entire catalog by default.
18. Durable operation follow-ups are capability contracts, not Runtime-internal API calls or polling loops.
19. Raw evidence reads are policy-gated and workspace-scoped; shallow events remain the default observation path.
20. Core/Cloud adapters depend on the capability transport contract; the transport never depends on Core or Cloud implementations.
21. Accepted Cloud capability assignments resume through contract follow-ups and original `operation_id` replay, never by rerunning the side effect blindly; wait capabilities may themselves remain `accepted` and return another bounded follow-up handle.
22. Cross-language consumers depend on generated `flyto2.execution.v1` wire schemas/fixtures, not Runtime's TypeScript implementation types.
23. Standalone Runtime explicitly enables the full production capability profile; composed callers may select bundles without changing the wire contract.
24. Agent delegation is an optional Runtime bundle over the existing local-agent lifecycle; provider credentials and provider sessions never become cross-product contract state.
25. Same-machine Core/Runtime composition crosses an authenticated localhost wire bridge; it never imports Runtime implementation or exposes the bridge through the public tunnel host.
26. MCP Events are the primary push signal for meaningful long-task state changes; durable process/task recovery remains authoritative when delivery is missed.
27. Failed/orphaned processes may move an owning Host Task to `needs_attention`, but Runtime never auto-completes or advances the ChatGPT-owned task plan.
