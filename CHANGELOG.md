# Changelog

## Unreleased

## 1.1.1 - 2026-09-26

- Setup can create a free Cloudflare quick tunnel instead of asking for a URL: it installs `cloudflared` with consent, keeps the tunnel running as a background service, waits until the new hostname exists in DNS, and the Runtime follows the URL whenever the tunnel restarts. `service quick-tunnel start|stop|status` manages it.
- `open_workspace` names the allowed roots in its description and in access denials.
- Cached ChatGPT `bash` calls wait for long commands and continue with `@flyto2/job <session>`.
- Add `service self-update`: a remote host can move the background service to the newest CI-green commit on main. An OS-owned one-shot job fetches, builds in its own directory, restarts behind the health gate, and rolls back on failure; `service self-update status` reports each phase.
- End setup on a status screen that probes local health, the public endpoint and the background service separately and keeps the MCP URL and Owner password together.
- Route cached ChatGPT `write`/`edit` calls through `apply_patch` in Codex mode.
- Add native macOS `local.flyto2.runtime` service lifecycle with install/start/stop/restart/status/update/rollback commands and direct `dist/cli.js serve` LaunchAgent execution.
- Add migration of existing fixed Cloudflare tunnels into Runtime-owned storage and the native `local.flyto2.runtime.tunnel` LaunchAgent.
- Expand `/healthz` into an auditable truth card with build Git SHA/timestamp, config/state schema versions, exact MCP tool surface, recent MCP/ChatGPT activity, tunnel state, reactive jobs, and watcher health.
- Prefer `FLYTO2_RUNTIME_CONFIG_DIR` while preserving `DEVSPACE_CONFIG_DIR` as a compatibility alias.
- Bound long Unix-domain socket endpoints with a deterministic short `/tmp/flyto2-agentd-<hash>.sock` fallback so macOS daemon startup remains reliable under long temporary/state paths.

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
