# Setup Guide

This guide covers ChatGPT, Claude, Codex, and custom MCP clients using Flyto2 Runtime with local projects. Flyto2 Cloud is optional.

## Requirements

- Node `>=22.19 <27`
- pnpm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS origin only when a remote client such as ChatGPT needs to reach the local Runtime

Flyto2 Runtime does not provision a new public tunnel account for you. It can import and supervise an existing fixed Cloudflare tunnel on macOS or Windows, including two redundant connectors and automatic repair.

## Install and configure

Run:

```bash
flyto2-runtime init
```

Choose the clients you intend to use and keep allowed project roots narrow. Local clients do not require a public tunnel or Flyto2 Cloud.

The canonical configuration-directory override is:

```text
FLYTO2_RUNTIME_CONFIG_DIR
```

Existing installations using `DEVSPACE_CONFIG_DIR` remain supported.

## ChatGPT

For ChatGPT, expose the Runtime origin over HTTPS and forward it to the local server, normally:

```text
http://127.0.0.1:7676
```

Configure the MCP endpoint as:

```text
https://your-runtime-host.example.com/mcp
```

The public origin stored in Runtime configuration should not include `/mcp`.

Complete OAuth with the Runtime Owner credential. Keep the owner credential and `auth.json` private.

Runtime serves its MCP and OAuth discovery routes from the same origin. A reverse proxy or tunnel must therefore forward the whole origin, not only the `/mcp` path.

### Compact model-facing tool surface

Flyto2 Runtime keeps scheduling, durable jobs, events, evidence, watches, recovery, service state, and tunnel supervision behind the execution boundary. A model should normally see only the primitives it needs to do work.

Codex mode exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, and `show_changes`. Claude compatibility mode exposes `open_workspace`, `read`, `write`, `edit`, `bash`, and `show_changes`.

Long non-interactive Codex commands automatically continue as durable Runtime jobs behind `exec_command`; the returned session is continued with `write_stdin`. Claude compatibility `bash` uses the same internal durable runner. Models do not need separate event, wait, or evidence tools for normal work.

If ChatGPT still shows a stale tool list, reconnect the connector or start a fresh conversation after Runtime has restarted. This is a client schema-cache issue.

## Claude, Codex, and custom MCP clients

The setup menu can print connection instructions for supported clients. Local MCP clients can connect directly to the Runtime origin without a public tunnel.

Subagents are independent of MCP access. A ChatGPT-only installation can leave every subagent provider disabled.

## Native background service

Flyto2 Runtime uses the same lifecycle commands on macOS and Windows:

```bash
flyto2-runtime service status
flyto2-runtime service start
flyto2-runtime service stop
flyto2-runtime service restart
flyto2-runtime service update
flyto2-runtime service rollback
```

On macOS, `local.flyto2.runtime` is a user LaunchAgent with RunAtLoad and KeepAlive. Logs are stored under `~/Library/Logs/Flyto2 Runtime/`.

On Windows, `Flyto2 Runtime` is a per-user Task Scheduler task started at logon. It launches a PowerShell supervisor that restarts a failed Runtime quickly with bounded backoff. Task Scheduler provides an additional restart fallback. Service start/restart is health-checked against local `/healthz`, and a failed update can restore the previous task definition and wrapper.

For source installs, double-click `Install.command` on macOS or `Install.cmd` on Windows. Both create the native background service and Desktop launchers.

## Cloudflare tunnel import and Mac Kit migration

For either desktop platform, an existing Cloudflare named-tunnel config can be imported without hand-writing a Runtime profile:

```bash
flyto2-runtime service tunnel-import /path/to/config.yml
```

If `cloudflared` is not already discoverable on PATH, pass `--cloudflared <path>`. If the config has no hostname-bearing ingress entry, pass `--hostname <host>`. Runtime copies the binary, config, and credentials into platform-native Runtime storage, rewrites the credential path, and stages two connector definitions with independent readiness ports.

Windows stores Runtime-owned data under `%LOCALAPPDATA%\\Flyto2 Runtime\\`; macOS uses `~/Library/Application Support/Flyto2 Runtime/`.

### Migrating an existing Mac Kit installation

Existing installations can be staged without stopping the currently working Runtime:

```bash
flyto2-runtime service stage
```

Staging does four things without loading the new services:

1. Creates the `local.flyto2.runtime` LaunchAgent.
2. Detects an existing fixed Cloudflare tunnel.
3. Copies the Cloudflare binary, tunnel configuration, and credentials into Runtime-owned storage.
4. Creates the `local.flyto2.runtime.tunnel` LaunchAgent.

Runtime-owned tunnel data is stored under:

```text
~/Library/Application Support/Flyto2 Runtime/tunnel/
```

The migrated tunnel keeps the existing hostname and tunnel ID while rewriting the credentials path to the Runtime-owned copy. Credentials are not printed by migration commands.

The legacy labels are:

```text
local.devspace.mac-kit
local.devspace.mac-kit.updater
```

They remain useful as rollback sources during migration, but the final native Runtime service does not require them.

Before cutover, verify:

```bash
flyto2-runtime service status
flyto2-runtime doctor
```

The old updater can be stopped independently after staging:

```bash
flyto2-runtime service disable-legacy-updater
```

Do not stop the old supervisor until the native Runtime and native tunnel definitions have been staged and validated. The old supervisor may currently own both the Runtime process and the public Cloudflare tunnel.

## Health and diagnostics

The local/public liveness endpoint is:

```text
http://127.0.0.1:7676/healthz
```

It intentionally exposes only minimal liveness information. Detailed process, package, service, tunnel, and platform status belongs in local or authenticated surfaces:

```bash
flyto2-runtime doctor
flyto2-runtime service status
```

Runtime tools provide durable job, event, evidence, and watcher state to authenticated MCP clients. Keeping `/healthz` minimal avoids exposing Git SHA, process IDs, tunnel internals, or tool inventory on a public tunnel.

## Build identity

`pnpm build` writes `dist/build-info.json` containing the package version, source Git SHA, and build timestamp. The receipt is used for package and local deployment verification rather than being exposed on public `/healthz`.

An explicitly packaged build can also provide `FLYTO2_BUILD_GIT_SHA` and `FLYTO2_BUILD_TIMESTAMP`.

## Existing state compatibility

Migration intentionally keeps existing OAuth, SQLite state, workspace bindings, allowed roots, and worktree locations unless the operator explicitly moves them. This avoids splitting one installation into two competing state stores.

The current config schema still accepts the established `config.jsonc` format. `FLYTO2_RUNTIME_CONFIG_DIR` is preferred, while `DEVSPACE_CONFIG_DIR` remains a compatibility alias.

## Development checkout

For repository development:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
flyto-index verify . --full-scan --strict --json
```

See [Development and Manual QA](development.md) for additional development workflows.
