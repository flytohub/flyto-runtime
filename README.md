# Flyto2 Runtime

**Flyto2 Runtime** is a local execution runtime for ChatGPT, Claude, coding agents, and Flyto2. It gives an authenticated MCP client a reliable way to work with local files, Git, tests, builds, processes, durable events, and filesystem watches while keeping execution on the user's machine.

Flyto2 Cloud is optional. Runtime works standalone.

## Features

- MCP workspace access for local files, edits, Git, tests, and builds
- Minimal Codex-grade MCP surface: workspace, files, patch/edit, process, and review primitives; durable jobs, events, evidence, and watches stay internal by default
- Durable operation IDs to prevent accidental replay of side effects
- Bounded local evidence for long-running process output
- Persistent filesystem watches that survive Runtime restart
- OAuth-protected remote MCP access for ChatGPT
- Native macOS LaunchAgent and Windows Task Scheduler lifecycle with health-checked restart and rollback
- Redundant two-connector Cloudflare tunnel supervision on macOS and Windows
- Cross-platform Cloudflare tunnel import into Runtime-owned storage
- Optional Flyto2 Cloud pairing through a versioned bridge
- Minimal public `/healthz` liveness plus detailed local diagnostics through `doctor`, `service status`, and Runtime tools

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

On macOS, double-click `Install.command`. On Windows, double-click `Install.cmd`. Both installers build a source checkout when necessary, create the native background service, and install Desktop launchers.

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

For the compact Codex-first surface on an existing installation:

```bash
flyto2-runtime config set tools.mode codex
flyto2-runtime config set tools.exposeRuntimeInternals false
flyto2-runtime service restart
```

Start or restart the native background service on macOS or Windows:

```bash
flyto2-runtime service start
flyto2-runtime service restart
```

For an existing Mac Kit installation, stage the Flyto2-native Runtime service and fixed Cloudflare tunnel without interrupting the currently running service:

```bash
flyto2-runtime service stage
```

On macOS the service is owned by `local.flyto2.runtime`; on Windows it is owned by the `Flyto2 Runtime` scheduled task. Redundant tunnel connectors are managed natively on both platforms. The old `local.devspace.mac-kit` labels remain macOS migration sources only and are not Runtime dependencies after cutover.

### ChatGPT

Point a public HTTPS endpoint at Runtime's local server, normally `http://127.0.0.1:7676`, and store the public origin as `server.publicBaseUrl`. Do not hard-code someone else's Runtime URL into a plugin.

During `flyto2-runtime init`, choosing ChatGPT asks whether you want to generate a personalized, upload-ready portable Plugin ZIP. Choose **Yes** to write it to `~/Downloads` when that folder exists, or **No** to save only the Runtime/MCP configuration and generate the ZIP later. The package is built from the current Runtime URL and contains only portable plugin metadata, MCP configuration, and a small Runtime skill. It never contains the Owner password, OAuth tokens, tunnel credentials, or `auth.json`.

You can regenerate it at any time:

```bash
flyto2-runtime plugin build
```

For another Runtime or a white-label package, override the connection and metadata without editing source:

```bash
flyto2-runtime plugin build \
  --url https://runtime.customer.example/mcp \
  --name customer-runtime \
  --server-name customer-runtime \
  --display-name "Customer Runtime" \
  --output ./customer-runtime-plugin.zip
```

The generated ZIP contains root `plugin.json`, root `mcp.json`, and `skills/<plugin-name>/SKILL.md` using the portable Agent Plugins schemas. Upload the ZIP in ChatGPT Plugins and complete OAuth once when ChatGPT connects to the MCP endpoint.

A client that cached an older MCP tool list may need its connection to be refreshed or a new conversation before the current compact surface appears.

### Runtime status and evidence

Use:

```bash
curl http://127.0.0.1:7676/healthz
```

The public response intentionally contains only minimal liveness fields. Use `flyto2-runtime doctor` and `flyto2-runtime service status` for detailed diagnostics without leaking process, build, tunnel, or tool inventory publicly. Runtime-internal MCP diagnostics can be explicitly enabled for development, but are hidden from models by default.

### Service lifecycle

```bash
flyto2-runtime service status
flyto2-runtime service update
flyto2-runtime service rollback
flyto2-runtime service stop
flyto2-runtime service start
```

`service rollback` restores the previous native service definition when one is available: LaunchAgent on macOS and the scheduled-task wrapper on Windows. Runtime keeps existing OAuth, workspace, SQLite state, and allowed-root configuration during migration.

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

On macOS, LaunchAgent owns the Runtime process; on Windows, Task Scheduler owns a PowerShell supervisor that restarts failed Runtime processes with bounded backoff. Both platforms can own two independent Cloudflare connectors, while the Runtime watchdog repairs degraded connectivity. Client tooling, Runtime execution, and optional Cloud orchestration remain separate layers.

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
