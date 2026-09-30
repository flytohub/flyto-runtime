# Flyto2-owned Runtime modules

This directory contains the Flyto2-specific TypeScript surface layered onto the upstream DevSpace fork.

- `protocol.ts`: provider-neutral `flyto2.execution.v1` schemas.
- `capability-catalog.ts`: canonical Runtime capability declarations used by the manifest and provider admission.
- `capability-provider.ts`: provider-neutral capability registry/execution seam. It owns no workspace, process, Git, Cloud, or persistence implementation.
- `capability-audit.ts`: adapter from shallow capability audit records into the existing durable Runtime event stream.
- `capability-runtime.ts`: Runtime-owned registry composition root.
- `read-only-capabilities.ts`: first provider adapters for checkout workspace open, source read, Git inspect, and non-advancing review diff.
- `execution-capabilities.ts`: policy-gated package test/build providers plus read-only durable process status.
- `mutation-capabilities.ts`: optional policy-gated source patching and local Git stage/commit providers. It deliberately excludes push/reset/clean/checkout.
- `manifest.ts`: standalone Runtime identity and capability manifest.
- `cloud-bridge.ts`: optional outbound Flyto2 Cloud pairing/job transport.
- `connected-runtime.ts`: dependency-injected claim/lease/progress/completion loop.
- `durable-operations.ts`: SQLite-backed exactly-once operation admission/replay.
- `durable-tools.ts`: MCP registration wrapper that adds `operation_id` to side-effecting tools.
- `runtime-events.ts`: durable monotonic Runtime event stream with cursor recovery, dedupe, filtering, bounded retention, and one-shot waits.
- `reactive-command.ts`: detached non-interactive command runner that stores bounded local evidence and emits shallow completion events.
- `tool-events.ts`: converts completed durable MCP mutations into shallow Runtime events without replay duplication.
- `runtime-tools.ts`: registers the Flyto2-native MCP tool surface outside upstream `server.ts` to reduce fork merge conflicts.
- `workspace-watch.ts`: persists native filesystem watches, emits shallow external-change events, restores watches after restart, and fails closed on canonical-root drift.

The Runtime core remains usable when the Cloud bridge is absent. Flyto2 modules must not import Flyto2 Cloud application code.

Capability implementations are intentionally migrated behind `capability-provider.ts` incrementally. Existing MCP tools remain the production path until an implementation has a focused provider adapter and regression coverage. Core and Cloud should consume the versioned contract/manifest, not Runtime workspace/process/database internals.

The provider registry does not replace durable side-effect admission. Providers that mutate files, Git, processes, or external systems must continue to use Runtime's existing `operation_id`/`DurableOperationStore` boundary underneath the provider seam.

Long-running capabilities return `status=accepted` with an opaque operation handle instead of claiming the work completed. `test.run` and `build.run` currently execute only the project's declared `test`/`build` package scripts, reuse `ReactiveCommandRunner`, and journal process admission with `DurableOperationStore`. `process.status` reads the resulting durable process without starting a second command. This keeps Core/Cloud composition asynchronous without adding a second workflow or polling engine.

Capability modules are independently composable. A registry may be read-only, add durable execution, add local mutation, or include both. Mutation providers reuse Runtime's existing workspace confinement, `applyPatch`, Git helpers, review snapshots, and `DurableOperationStore`. `git.mutate` is intentionally local-only in this layer: it can stage the current workspace and commit only when every staged path is inside that workspace. Commits respect the repository's normal Git hooks/signing configuration and are bounded by a non-interactive timeout. Network publication and destructive Git operations are not part of this capability.

The live Runtime manifest is generated from `registeredCapabilities()`, not the full catalog. The catalog describes what this Runtime build knows how to provide; the live manifest describes what this particular composed Runtime instance actually exposes. This distinction is what lets the same package boot as read-only, execution-enabled, mutation-enabled, or fully composed without advertising unavailable modules.
