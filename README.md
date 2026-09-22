# Flyto2 Runtime

**Flyto2 Runtime** is a local execution runtime for ChatGPT, Claude, coding agents, and Flyto2. It gives an authenticated MCP client a reliable way to work with local files, Git, tests, builds, processes, durable events, and filesystem watches while keeping execution on the user's machine.

Flyto2 Cloud is optional. Runtime works standalone.

## Features

- MCP workspace access for local files, edits, Git, tests, and builds
- Full reactive Runtime surface: `runtime_manifest`, `runtime_run`, `runtime_wait`, `runtime_events`, `runtime_evidence`, `runtime_signal`, `runtime_watch`, `runtime_unwatch`, and `runtime_watches`
- Durable operation IDs to prevent accidental replay of side effects
- Bounded local evidence for long-running process output
- Persistent filesystem watches that survive Runtime restart
- OAuth-protected remote MCP access for ChatGPT
- Native macOS LaunchAgent lifecycle and fixed Cloudflare tunnel migration
- Optional Flyto2 Cloud pairing through a versioned bridge
- Auditable `/healthz` truth card with version, Git SHA, build timestamp, schemas, MCP surface, tunnel state, recent client activity, jobs, and watchers

## Installation

Requirements:

- Node `>=22.19 <27`
- pnpm
- Git
- Bash

Build from source:

```bash
git clone https://github.com/flytohub/flyto-runtime.git
cd flyto-runtime
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

On macOS, double-click `Install.command`. The installer creates the native background service and Desktop launchers.

## Usage

Initialize or update local configuration:

```bash
flyto2-runtime init
```

Check the installation:

```bash
flyto2-runtime doctor
flyto2-runtime service status
```

Start or restart the native macOS background service:

```bash
flyto2-runtime service start
flyto2-runtime service restart
```

For an existing Mac Kit installation, stage the Flyto2-native Runtime service and fixed Cloudflare tunnel without interrupting the currently running service:

```bash
flyto2-runtime service stage
```

After validation, the native services are:

```text
local.flyto2.runtime
local.flyto2.runtime.tunnel
```

The old `local.devspace.mac-kit` and updater labels are compatibility-only migration sources and are not required by the native service after cutover.

### ChatGPT

Point the public HTTPS endpoint at Runtime's local server, normally `http://127.0.0.1:7676`, then connect ChatGPT to:

```text
https://your-runtime-host.example.com/mcp
```

Complete OAuth once. Runtime exposes the same MCP endpoint for modern and supported legacy client schemas.

A client that cached an older MCP tool list may need its connector to be reconnected or a new conversation before newly added `runtime_*` tools appear. The server-side `/healthz` endpoint reports whether the complete Runtime tool surface is actually registered.

### Runtime status and evidence

Use:

```bash
curl http://127.0.0.1:7676/healthz
```

The response includes Runtime version, Git SHA, build timestamp, config/state schema versions, public MCP endpoint, native tunnel state, registered tool names, full-tool-surface status, last successful MCP/ChatGPT request timestamps, reactive job counts, and watcher health.

### Service lifecycle

```bash
flyto2-runtime service status
flyto2-runtime service update
flyto2-runtime service rollback
flyto2-runtime service stop
flyto2-runtime service start
```

`service rollback` restores the previous native LaunchAgent definition when one is available. Runtime keeps existing OAuth, workspace, SQLite state, and allowed-root configuration during migration.

## Configuration

`FLYTO2_RUNTIME_CONFIG_DIR` is the canonical configuration-directory override. `DEVSPACE_CONFIG_DIR` remains supported as a compatibility alias for existing installations.

Existing state remains compatible with the current `config.jsonc`, OAuth data, workspace state, and SQLite layout. The migration path intentionally avoids creating a second competing state store.

For ChatGPT-only installations, subagents may stay disabled.

See [Setup Guide](docs/setup.md) for client setup, service migration, and operational details.

## Architecture

The standalone execution path is:

```text
ChatGPT / MCP client
  -> OAuth
  -> Flyto2 Runtime
  -> workspace / Git / process / reactive events / filesystem watches
  -> optional Flyto2 Cloud
```

On macOS, `local.flyto2.runtime` owns the Runtime process and `local.flyto2.runtime.tunnel` can own a migrated fixed Cloudflare tunnel. Client tooling, Runtime execution, and optional Cloud orchestration remain separate layers.

## Testing

The repository verification loop is:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
flyto-index verify . --full-scan --strict --json
```

Runtime-owned service, tunnel migration, MCP compatibility, health evidence, durable execution, and filesystem-watch behavior are covered by automated tests.

## Security

Runtime is intentionally bound to authenticated MCP/OAuth access. Keep owner credentials, tunnel credentials, and `auth.json` private. Restrict allowed workspace roots to directories the client should be able to modify. The Runtime does not claim that shell execution is an OS sandbox.

## Roadmap

Flyto2 Runtime will connect with **Flyto2 Core** to extend local execution into reusable capabilities such as web crawling, browser testing, automated validation, security testing, and agent-driven workflows.

## License

MIT. This project is based on [Waishnav/devspace](https://github.com/Waishnav/devspace). The original copyright and license notice are preserved in [LICENSE](LICENSE).
