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

Store only the public origin in Runtime configuration:

```text
https://your-runtime-host.example.com
```

Do not include `/mcp` in `server.publicBaseUrl`. Runtime derives the MCP resource as `/mcp`.

When ChatGPT is selected during interactive `flyto2-runtime init`, Runtime asks whether to generate a personalized portable Plugin ZIP. Choose Yes to create it immediately; choose No to keep only the Runtime/MCP settings and build the ZIP later. Interactive CLI generation defaults to `~/Downloads/flyto2-runtime-chatgpt-plugin.zip` when `~/Downloads` exists. When `plugin build` is invoked from the managed Runtime service (for example through ChatGPT), the default destination is the Runtime config directory instead, avoiding macOS protected-folder/TCC prompts. The ZIP contains no credentials.

Regenerate or customize the package at any time:

```bash
flyto2-runtime plugin build
flyto2-runtime plugin build --url https://runtime.customer.example/mcp --name customer-runtime
flyto2-runtime plugin build --help
```

The generator uses `server.publicBaseUrl` by default, but `--url`, `--base-url`, plugin identity, MCP server name, description, version, and output path are all overridable. This keeps the distribution reusable for other users and other Runtime hostnames instead of baking in `devspace.flyto2.com` or any other deployment.

Upload the generated ZIP in ChatGPT Plugins, then complete OAuth with the Runtime Owner credential. Keep the owner credential and `auth.json` private.

Runtime serves its MCP and OAuth discovery routes from the same origin. A reverse proxy or tunnel must therefore forward the whole origin, not only the `/mcp` path.

### Compact model-facing tool surface

Flyto2 Runtime keeps scheduling, durable jobs, events, evidence, watches, recovery, service state, and tunnel supervision behind the execution boundary. A model should normally see only the primitives it needs to do work.

Codex mode exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, `show_changes`, and `background_task`. Claude compatibility mode exposes `open_workspace`, `read`, `write`, `edit`, `bash`, `show_changes`, and `background_task`. The compatibility-named `background_task` stores ChatGPT-owned recovery state only; it never starts Codex, Claude, or another model.

Long non-interactive Codex commands automatically continue behind `exec_command`; the returned opaque process session is continued with `write_stdin`. Interactive PTY sessions use the same model-facing session shape, so the model never needs to choose between process implementations. Claude compatibility `bash` uses the same internal execution machinery. Models do not need separate event, wait, or evidence tools for normal work.

To switch an existing installation to the Codex-first surface, run `flyto2-runtime config set tools.mode codex` and then `flyto2-runtime service restart`. Rebuild and replace the ChatGPT Plugin ZIP after a tool-surface change: generated packages now use a revisioned MCP catalog id such as `flyto2-runtime-codex-v2`, forcing a fresh tool scan instead of reusing the legacy five-tool identity. Until the host refreshes its schema, a cached `bash` call using `@flyto2/task start <complete task>` is translated to the durable ChatGPT-owned task store. ChatGPT continues the work itself with the normal workspace tools; Runtime only preserves recovery state.

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
