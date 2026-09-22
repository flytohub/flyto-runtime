# Changelog

## Unreleased

- Add a durable Flyto2 Runtime event reactor with monotonic cursors, event dedupe/fail-closed drift handling, bounded retention, filtering, and one-shot waits.
- Add `runtime_run`, `runtime_wait`, `runtime_events`, `runtime_evidence`, and `runtime_signal` MCP tools so long tests/builds can complete without model-driven process polling.
- Store reactive process logs as bounded local evidence; shallow events contain only status/digest/evidence references, and interrupted jobs become explicit `process.orphaned` events after restart.
- Emit `workspace.changed` and Cloud assignment lifecycle events into the same Runtime stream while suppressing duplicate events on durable operation replay.
- Add durable `runtime_watch`, `runtime_unwatch`, and `runtime_watches` support for native external filesystem events; watches survive restart, canonicalize targets, fail closed on root retargeting, and batch events without starvation.

- Add a macOS one-click Flyto2 Runtime experience: `Install.command`, a double-click `Flyto2 Runtime.command`, a TypeScript interactive management menu, and generated Desktop shortcuts for start/doctor/setup. The shell files remain thin launchers; product behavior stays in TypeScript.
- Fork upstream DevSpace as **Flyto2 Runtime** while preserving the MIT license, upstream history, existing `devspace` CLI alias, and compatible local state layout.
- Add the provider-neutral `flyto2.execution.v1` TypeScript protocol and standalone `runtime_manifest` MCP tool.
- Add an optional outbound Flyto2 Cloud bridge that reuses the existing paired-device job/claim/lease/progress/completion lifecycle without making Cloud a Runtime dependency.
- Add dependency-injected connected execution so Cloud composition does not know local provider, worktree, process-session, or SQLite implementation details.
- Add SQLite-backed durable `operation_id` admission/replay for side-effecting MCP operations, including atomic concurrent admission and fail-closed uncertain retries.
- Reduce the default long process receipt window to 3 seconds while preserving interactive continuation.
- Add Flyto2 architecture lint, source-linked documentation coverage, and strict repository verification in CI.
