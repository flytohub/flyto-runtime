# Configuration Reference

DevSpace stores durable settings in `~/.devspace/config.jsonc`. The file accepts
comments and trailing commas and is validated before the server starts. Editor
completion is provided by the versioned [JSON Schema](../schema/v1/devspace.schema.json),
also hosted at the URL in the file's `$schema` property.

Authentication stays separate because it contains a secret:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

Run `devspace init` to create both files. The config CLI updates the JSONC
document without discarding its comments, including `devspace config set
publicBaseUrl <url|null>`, `flyto2-runtime config set tools.mode <codex|claude>`,
and `flyto2-runtime config set tools.exposeRuntimeInternals <true|false>`.

For ChatGPT, `flyto2-runtime plugin build` reads `server.publicBaseUrl` and
creates a personalized portable Plugin ZIP. The endpoint and plugin metadata can
also be overridden with CLI flags, so no deployment hostname is compiled into
the Runtime. The generated package contains no Runtime credentials.

## Complete example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Waishnav/devspace/main/schema/v1/devspace.schema.json",
  "configVersion": 1,

  "server": {
    "host": "127.0.0.1",
    "port": 7676,
    // Use the public origin only; do not append /mcp.
    "publicBaseUrl": "https://devspace.example.com",
    "allowedHosts": [],
    "trustProxy": false,
  },
  "workspaces": {
    "allowedRoots": ["~/personal", "~/work"],
    "worktreeRoot": "~/.devspace/worktrees",
  },
  "storage": {
    "stateDir": "~/.local/share/devspace",
  },
  "tools": {
    "mode": "codex",
    "exposeRuntimeInternals": false,
  },
  "ui": {
    "enabled": true,
  },
  "artifacts": {
    "enabled": false,
    "maxFileBytes": 104857600,
  },
  "skills": {
    "enabled": true,
    "paths": [],
    "agentDir": "~/.codex",
  },
  "subagents": {
    "enabled": false,
    "instructions": "on-demand",
    "providers": [],
  },
  "logging": {
    "level": "info",
    "format": "json",
    "requests": true,
    "assets": false,
    "toolCalls": true,
    "shellCommands": false,
  },
  "oauth": {
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 2592000,
    "scopes": ["devspace"],
    "allowedResourceUrls": [],
    "allowedRedirectHosts": ["chatgpt.com", "localhost", "127.0.0.1"],
  },
}
```

Omitted sections and keys use the defaults shown above. An empty
`workspaces.allowedRoots` uses the current working directory. Unknown keys are
rejected so spelling mistakes cannot silently alter behavior.

`oauth.allowedResourceUrls` accepts exact alternate MCP resource URLs for
clients that connect through a resource alias, such as a secure MCP tunnel.
The normal `server.publicBaseUrl` `/mcp` resource remains allowed automatically.
Configure the complete alias URL, not a hostname or origin; aliases do not
change OAuth discovery URLs or proxy routing.
Resource URLs must use HTTPS; HTTP is allowed only for `localhost`, `127.0.0.1`,
or `[::1]`, with optional ports. Restart DevSpace after changing
`oauth.allowedResourceUrls`: the provider reads this policy at server creation.
After restarting, refresh tokens for removed aliases can no longer mint tokens.

## Tool modes and UI

`tools.mode` accepts two values:

| Value | Tool surface |
| --- | --- |
| `codex` | Default. `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, and `show_changes`. |
| `claude` | `open_workspace`, `read`, `write`, `edit`, `bash`, and `show_changes`. |

The dedicated MCP tools `grep`, `glob`, and `ls` are not exposed. Each mode uses
its shell tool with programs such as `rg`, `find`, and `ls` when it needs those
operations. Codex process sessions are deliberately opaque: interactive PTY and
long non-interactive execution both return the same string `session_id` shape,
and Runtime chooses yield windows, output bounds, and terminal sizing internally.
Changing `tools.mode` requires a Runtime restart before connected clients see the
new tool catalog.

`tools.exposeRuntimeInternals` defaults to `false`. Set it to `true` only for
Runtime development or diagnostics when direct access to internal manifest,
event, evidence, signal, and filesystem-watch tools is required. Normal model
work should leave these mechanics hidden behind `exec_command` / `write_stdin`
or the Claude compatibility `bash` tool.

Flyto2 Runtime no longer emits MCP Apps/result-card metadata. `open_workspace`
and `show_changes` are plain MCP tools, so ChatGPT does not create iframe cards
or retain large diff payloads in conversation state. The legacy `ui.enabled`
field is still accepted in v1 configuration files for upgrade compatibility,
but it has no runtime effect.

In Codex mode, the initial workspace response contains required instruction
files, nested instruction paths, and the on-demand skill catalog. The compact
`background_task` compatibility tool persists ChatGPT-owned recovery state:
the original task, workspace binding, checkpoints, and final result. It never
starts a subagent provider. Reopening the same checkout in the same conversation
is only a lightweight workspace handshake and does not resend the discovery
payload.

## Skills and subagents

DevSpace discovers standard Agent Skills from `~/.agents/skills`, project
`.agents/skills`, and `~/.devspace/skills`. It also checks
`skills.agentDir/skills` and each path in `skills.paths`. Relative custom paths
are resolved from the active workspace.

When Subagents are enabled for MCP workspaces, DevSpace keeps its bundled
`subagents` skill synchronized at `~/.devspace/skills/subagents/SKILL.md`.
That managed copy is the authoritative `subagents` skill for DevSpace and is
refreshed when the packaged skill changes.

Subagent providers are explicit. Omitted providers are disabled:

```jsonc
{
  "configVersion": 1,
  "subagents": {
    "enabled": true,
    "instructions": "on-demand",
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.4",
        "effort": "high",
        "command": "/opt/devspace/bin/codex-wrapper",
        "env": {
          "CODEX_HOME": "/home/alice/.codex-work",
          "OPENAI_BASE_URL": "https://api.example.com/v1",
        },
      },
      {
        "id": "claude",
        "enabled": true,
        "model": "sonnet",
      },
    ],
  },
}
```

`subagents.instructions` controls when ChatGPT receives the managed workflow:

| Value | Behavior |
| --- | --- |
| `on-demand` | Default. `open_workspace` advertises the `subagents` skill and the model reads it only when the task benefits from delegation. |
| `preload` | Claude-mode clients may include the `subagents` workflow in the initial workspace instructions instead of advertising that skill for a separate read. ChatGPT/Codex mode still keeps delegation on-demand so ordinary workspace opens stay compact. |

Both modes keep ordinary work on the primary tools. In ChatGPT/Codex mode,
`background_task` only persists recovery state for multi-step work that may
cross a page or MCP reconnect; ChatGPT continues the actual analysis, edits,
verification, and commit work itself. Subagent providers run only through an
explicit user-requested delegation workflow.

Profiles are loaded from `~/.devspace/agents/*.md` and project
`.devspace/agents/*.md`. `devspace agents targets` prints the configured targets
available in the current workspace.

`command` names one executable. DevSpace does not split shell arguments, so use
a wrapper executable when startup needs fixed arguments. `env` maps environment
variable names to literal string values and preserves empty strings. DevSpace
does not expand `$NAME` references in these values.

All subagent providers accept `env`. The daemon inherits its startup
environment, then overlays the provider's `env` without mutating the daemon's
process environment. OpenCode receives that environment on its managed server
process; embedded Pi scopes it to its provider requests and command execution.

Codex, Claude, Cursor, Copilot, and Grok also accept `command`. OpenCode and Pi
do not expose a command override. For providers that support it, an explicit
`command` wins over both the inherited command override and a command override
placed in `env`.

Existing process-level overrides remain supported: `CODEX_COMMAND`,
`CODEX_HOME`, `CLAUDE_COMMAND`, `CURSOR_COMMAND`, `COPILOT_COMMAND`,
`GROK_COMMAND`, and `GROK_AGENT_PROFILE`. Provider configuration takes
precedence where the same value is set in both places.

DevSpace writes `config.jsonc` with mode `0600`, but provider environment values
are still plain text on disk. Keep the file out of version control. Leave
credentials in the process environment if you do not want DevSpace to persist
them.

## Native artifact download

Set `artifacts.enabled` to `true` when a host needs to save a native attached or
generated file into an open workspace. `artifacts.maxFileBytes` limits one
streamed file. The secure publication path is available on Linux, macOS, and
Windows; the tool is not registered on BSD.

## Environment boundary

Only two user-facing DevSpace environment variables remain:

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_CONFIG_DIR` | Bootstrap location for `config.jsonc`, `auth.json`, skills, and profiles. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Optional secret override for the owner token stored in `auth.json`. |

Durable environment settings were removed in v1.1. Move existing deployment
values to these JSONC keys:

| Removed setting | JSONC key |
| --- | --- |
| `HOST`, `PORT` | `server.host`, `server.port` |
| `DEVSPACE_PUBLIC_BASE_URL` | `server.publicBaseUrl` |
| `DEVSPACE_ALLOWED_HOSTS` | `server.allowedHosts` |
| `DEVSPACE_TRUST_PROXY` | `server.trustProxy` |
| `DEVSPACE_ALLOWED_ROOTS` | `workspaces.allowedRoots` |
| `DEVSPACE_WORKTREE_ROOT` | `workspaces.worktreeRoot` |
| `DEVSPACE_STATE_DIR` | `storage.stateDir` |
| `DEVSPACE_TOOL_MODE`, `DEVSPACE_MINIMAL_TOOLS` | `tools.mode` |
| `DEVSPACE_WIDGETS` | legacy `ui.enabled` compatibility field (no runtime effect) |
| `DEVSPACE_ARTIFACTS` | `artifacts.enabled` |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `artifacts.maxFileBytes` |
| `DEVSPACE_SKILLS` | `skills.enabled` |
| `DEVSPACE_SKILL_PATHS` | `skills.paths` |
| `DEVSPACE_AGENT_DIR` | `skills.agentDir` |
| `DEVSPACE_SUBAGENTS` | `subagents.enabled` |
| `DEVSPACE_LOG_LEVEL` | `logging.level` |
| `DEVSPACE_LOG_FORMAT` | `logging.format` |
| `DEVSPACE_LOG_REQUESTS` | `logging.requests` |
| `DEVSPACE_LOG_ASSETS` | legacy `logging.assets` compatibility field (no runtime effect) |
| `DEVSPACE_LOG_TOOL_CALLS` | `logging.toolCalls` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `logging.shellCommands` |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `oauth.accessTokenTtlSeconds` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `oauth.refreshTokenTtlSeconds` |
| `DEVSPACE_OAUTH_SCOPES` | `oauth.scopes` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `oauth.allowedRedirectHosts` |

These environment values are not read or auto-imported in v1.1. Environment is
process state, so there is no reliable file DevSpace can migrate on the user's
behalf.

## v1.0 file migration

The first v1.1 load performs one migration when `config.jsonc` is missing and
`config.json` exists:

1. Validate the old JSON document.
2. Translate its known fields into the versioned JSONC structure.
3. Write and validate a temporary `config.jsonc`.
4. Atomically publish it.
5. Rename the old file to `config.json.v1.0.bak`.

If `config.jsonc` exists, DevSpace never reads `config.json`. Invalid JSONC also
never falls back to the old file. Unsupported legacy keys stop migration with an
actionable error instead of being silently discarded.

The persisted fields map as follows:

| v1.0 JSON field | v1.1 JSONC key |
| --- | --- |
| `host`, `port` | `server.host`, `server.port` |
| `publicBaseUrl`, `allowedHosts` | `server.publicBaseUrl`, `server.allowedHosts` |
| `allowedRoots`, `worktreeRoot` | `workspaces.allowedRoots`, `workspaces.worktreeRoot` |
| `stateDir` | `storage.stateDir` |
| `artifactsEnabled`, `artifactMaxFileBytes` | `artifacts.enabled`, `artifacts.maxFileBytes` |
| `agentDir` | `skills.agentDir` |
| `subagents` | `subagents` |
| `tools.mode` | unchanged nested key |
| `ui.enabled` | retained as a compatibility-only no-op |

`auth.json` is unchanged.
