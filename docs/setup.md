# Setup Guide

This guide covers Codex, ChatGPT, Claude, and custom MCP clients using Flyto2 Runtime with local projects.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local DevSpace server, only when
  ChatGPT will connect

DevSpace does not create the public tunnel for you. ChatGPT users can use
Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or their own HTTPS reverse
proxy.

## Install And Configure

Run:

```bash
flyto2-runtime init
```

The setup flow asks one question at a time.

First choose one or more clients: **Codex**, **ChatGPT**, **Claude**, or **Direct MCP / custom client**.
DevSpace uses that answer to skip setup that does not apply to you.
This selects where you invoke DevSpace from. It does not control which agents
DevSpace may run for delegated work.

### Project roots

Every MCP client selects the project folders it may open through Runtime. Keep this narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

All clients share the existing `config.jsonc`, allowed roots, state, and OAuth configuration.
No Flyto2 Cloud account or public tunnel is required for local MCP use.
Selecting a local client preserves any existing public tunnel URL.

### Connect Codex

Choose **Setup / choose client** in the Desktop launcher, then **Codex**.
Setup displays connection instructions and selects the existing Codex tool surface.
It does not register any client or launch OAuth automatically. Only if you want
to connect Codex, run the displayed `codex mcp add` command, start Runtime, then
complete OAuth authorization:

```bash
codex mcp login flyto2-runtime
```

Approve access with your Runtime Owner password and reopen Codex to load the
tools. For ChatGPT-only use, select only ChatGPT and leave optional subagents unselected.
Codex owns its MCP
configuration and OAuth credentials; Runtime does not duplicate them.

### Connect Claude or a custom client

Claude setup prints the `claude mcp add --transport http` command. Use `/mcp`
in Claude Code to authorize. Other clients use the displayed Streamable HTTP
URL and OAuth discovery. The standalone Runtime works without Flyto2 Cloud.

### Subagents

Setup separately detects supported agents and asks which ones Runtime may use as
subagents. ChatGPT or another coding agent can delegate work through DevSpace
to the agents selected here.
You can leave all providers unselected to disable delegation; MCP still works.
These choices are stored as provider objects under `subagents` in
`~/.devspace/config.jsonc`.

### Coding Agents

If you selected Coding Agents, setup prints:

```bash
npx skills add flytohub/flyto-runtime --skill subagents --global
```

The Skills CLI asks which installed Coding Agents should receive the skill.
The skill uses `devspace agents targets`, `run`, `continue`, `show`, `wait`, and `ls`.
These commands do not require `devspace serve`.

This Coding Agent installation is separate from ChatGPT MCP usage. For MCP
workspaces with Subagents enabled, DevSpace manages its own copy at
`~/.devspace/skills/subagents/SKILL.md`; users do not install that copy
manually.

### Connect ChatGPT

Setup only asks for a public URL if you selected ChatGPT. Start your tunnel or
reverse proxy first and point it at:

```text
http://127.0.0.1:7676
```

For Tailscale Funnel, proxy the whole DevSpace server from the root path:

```bash
tailscale funnel --bg 7676
```

Do not mount Funnel only at `/mcp` with `--set-path=/mcp`. DevSpace also serves
OAuth discovery and authorization routes outside `/mcp`, and a path mount can
strip `/mcp` before the request reaches DevSpace.

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

Protocol compatibility is automatic. DevSpace serves MCP 2026-07-28 requests
directly and handles older 2025-era clients statelessly on the same endpoint;
there is no client-protocol setting to maintain.

A Coding Agents-only setup skips this section.

## Start The Server

Run:

```bash
npx @waishnav/devspace serve
```

If your tunnel URL changes, update the persisted value before starting:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, DevSpace shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
npx @waishnav/devspace doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are developing DevSpace itself instead of using the published package:

Local checkout development additionally requires pnpm 11.25.0, the version
pinned in `package.json`. Install it with `npm install --global pnpm@11.25.0`.

```bash
pnpm install --frozen-lockfile
pnpm dev:seed
pnpm dev
```

The source server uses an ignored checkout-local fork of your normal DevSpace
configuration and SQLite state. See [Development and Manual QA](development.md)
for worktree switching, ChatGPT testing, and database migration workflows.

## Existing macOS background installation

Desktop launchers preserve the `DEVSPACE_CONFIG_DIR` active when installed.
To point them at an existing service configuration, set that environment variable
and run `flyto2-runtime launcher install`. Start Runtime recognizes a healthy
background Runtime on its configured port.

Before migrating an old DevSpace service, validate this checkout and a copy of
its existing SQLite state on a separate port. Back up the service settings and
state, disable the old upstream updater, and point the service entry at this
checkout's `dist/cli.js` with the same Node runtime used to build dependencies.
Keep the tunnel configuration, owner credentials, allowed roots and storage paths.
The legacy Mac Kit supervisor must update the public URL through Runtime's
`setDevspaceConfigValue` from `dist/user-config.js`: migration replaces the old
`config.json` with `config.jsonc`, so its old read/write logic must be adapted
before restarting. Do not maintain a second legacy config copy.
Restart only the Runtime child after validation; verify `/healthz`, OAuth and MCP
before treating the migration as complete. Keep the backup for rollback.

Existing ChatGPT connections with cached DevSpace schemas remain supported: the
ChatGPT setup selects the standard read/write/edit/bash tool surface; this is
independent of local-agent providers. The HTTP boundary translates legacy `workspaceId`, `workingDirectory`, and `baseRef`
arguments to their Runtime equivalents. Conflicting old and new values are rejected.
