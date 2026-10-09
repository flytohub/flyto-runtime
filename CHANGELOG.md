# Changelog

## Unreleased — local-first mobile gateway (2026-10-10)

- Opt-in HTTPS mobile API exposing the registered Runtime capability
  manifest and invocation/result contract.
- Added one-use pairing code, 30-minute mobile session, TLS certificate
  fingerprint display, explicit capability allowlist, high-risk denial
  and operation-ID replay protection.
- No change to same-user localhost bridge and no mandatory Cloud service.

## Unreleased

## 1.1.4 - 2026-09-30

- Surface already-running durable process sessions in `open_workspace` recovery, including their originating workspace IDs and bounded progress, so a fresh ChatGPT conversation can inspect an existing CI/build/watch session instead of launching duplicate waiters.

## 1.1.3 - 2026-09-29

- Split durable non-interactive process observation from TTY input: Codex mode now exposes read-only `process_status` snapshots that never wait, while `write_stdin` remains the interactive input surface with a non-blocking compatibility path for cached v2 catalogs.
- Remove Runtime-owned task orchestration: `background_task` now stores only durable task identity, checkpoints, optional descriptive plan progress, and explicit terminal state; it no longer runs stage commands, advances plans, or auto-completes work.
- Bound tool draining and HTTP/application shutdown so a stuck tool promise cannot block a managed service restart indefinitely.
- Bump generated ChatGPT Plugin catalog identity to `codex-v4` so hosts rescan the simplified task and process surfaces instead of reusing a cached schema.

## 1.1.2 - 2026-09-29

- Add a self-contained Windows x64 Runtime ZIP with bundled Node.js, production
  dependencies, and Cloudflare-signed `cloudflared.exe`; Windows users can
  extract it and run `Install.cmd` without installing Node or pnpm first.
- Extend the Runtime release candidate to carry Windows x64 alongside both
  notarized macOS disk images, with one merged CycloneDX SBOM, SHA-256
  checksums, build provenance, and SBOM attestations covering every distributed
  Runtime package.
- Keep durable non-interactive commands inside the ChatGPT task instead of
  forcing the assistant turn to end when a command becomes a Runtime session.

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
