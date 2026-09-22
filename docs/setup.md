# Setup Guide

This guide covers ChatGPT, Claude, Codex, and custom MCP clients using Flyto2 Runtime with local projects. Flyto2 Cloud is optional.

## Requirements

- Node `>=22.19 <27`
- pnpm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS origin only when a remote client such as ChatGPT needs to reach the local Runtime

Flyto2 Runtime does not provision a new public tunnel account for you. It can, however, migrate and run an existing fixed Cloudflare tunnel as a native Runtime service on macOS.

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

### Full Runtime tool surface

A current ChatGPT connection can expose:

- `runtime_manifest`
- `runtime_run`
- `runtime_wait`
- `runtime_events`
- `runtime_evidence`
- `runtime_signal`
- `runtime_watch`
- `runtime_unwatch`
- `runtime_watches`

If ChatGPT still shows only an older cached workspace/read/write/edit/bash surface, reconnect the connector or start a fresh conversation after Runtime has restarted. This is a client schema-cache issue; `/healthz` reports the server-side registered tool list and whether the complete Runtime surface is loaded.

## Claude, Codex, and custom MCP clients

The setup menu can print connection instructions for supported clients. Local MCP clients can connect directly to the Runtime origin without a public tunnel.

Subagents are independent of MCP access. A ChatGPT-only installation can leave every subagent provider disabled.

## Native macOS background service

Flyto2 Runtime owns its native background service:

```text
local.flyto2.runtime
```

The LaunchAgent starts `dist/cli.js serve` directly. It does not depend on the old Mac Kit `service.mjs`.

Common lifecycle commands:

```bash
flyto2-runtime service status
flyto2-runtime service start
flyto2-runtime service stop
flyto2-runtime service restart
flyto2-runtime service update
flyto2-runtime service rollback
```

Logs are written under:

```text
~/Library/Logs/Flyto2 Runtime/
```

`service rollback` restores the previous native LaunchAgent definition when a previous definition exists.

## Migrating an existing Mac Kit installation

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

## Runtime truth card

The local status endpoint is:

```text
http://127.0.0.1:7676/healthz
```

It reports:

- Runtime version
- Git SHA
- build timestamp
- process start time and PID
- config schema version
- state schema version
- public MCP URL
- native tunnel status
- MCP tool mode
- exact registered tools
- whether the full `runtime_*` surface is loaded
- last successful MCP request
- last request identified as ChatGPT/OpenAI
- reactive job health
- filesystem watcher health

This is intended to prove that the build on disk, the running background process, and the MCP surface agree.

## Build identity

`pnpm build` writes `dist/build-info.json` containing the package version, source Git SHA, and build timestamp. Runtime reads this receipt for `/healthz`.

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
