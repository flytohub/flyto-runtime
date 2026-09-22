# Changelog

## Unreleased

- Add a macOS one-click Flyto2 Runtime experience: `Install.command`, a double-click `Flyto2 Runtime.command`, a TypeScript interactive management menu, and generated Desktop shortcuts for start/doctor/setup. The shell files remain thin launchers; product behavior stays in TypeScript.
- Fork upstream DevSpace as **Flyto2 Runtime** while preserving the MIT license, upstream history, existing `devspace` CLI alias, and compatible local state layout.
- Add the provider-neutral `flyto2.execution.v1` TypeScript protocol and standalone `runtime_manifest` MCP tool.
- Add an optional outbound Flyto2 Cloud bridge that reuses the existing paired-device job/claim/lease/progress/completion lifecycle without making Cloud a Runtime dependency.
- Add dependency-injected connected execution so Cloud composition does not know local provider, worktree, process-session, or SQLite implementation details.
- Add SQLite-backed durable `operation_id` admission/replay for side-effecting MCP operations, including atomic concurrent admission and fail-closed uncertain retries.
- Reduce the default long process receipt window to 3 seconds while preserving interactive continuation.
- Add Flyto2 architecture lint, source-linked documentation coverage, and strict repository verification in CI.
