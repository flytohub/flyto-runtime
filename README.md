# Flyto2 Runtime

**Flyto2 Runtime** is a standalone local execution runtime for ChatGPT, Claude, coding agents, and Flyto2 Cloud.

It can be used in two completely separate ways:

```text
Standalone
ChatGPT / Claude -> MCP -> Flyto2 Runtime -> local workspace / Git / tests / agents

Optional Flyto2 composition
ChatGPT -> Flyto2 Cloud -> thin execution protocol -> Flyto2 Runtime
```

The Runtime never imports `flyto-cloud` and does not require a Cloud account. Cloud integration is an optional outbound bridge layered on top of the same standalone capability manifest. Removing or disabling that bridge does not change the MCP/workspace/runtime core.

This repository is an independent MIT-licensed fork of [Waishnav/devspace](https://github.com/Waishnav/devspace). The upstream copyright and MIT license are preserved in [LICENSE](LICENSE). See [NOTICE.md](NOTICE.md) for fork attribution and compatibility notes.

## Flyto2 execution boundary

The shared contract is versioned as `flyto2.execution.v1`. Runtime exposes one provider-neutral manifest:

```text
runtime_manifest
  -> runtime identity
  -> roles
  -> capabilities
  -> risk / approval metadata
  -> evidence kinds
```

Flyto2 Cloud sees only this contract plus assignment/event/evidence/completion envelopes. It does not need to know whether a task is implemented by Codex, Claude, a Git worktree, a local process, or another adapter.

Pairing with Flyto2 Cloud is optional:

```bash
flyto2-runtime flyto2 manifest
flyto2-runtime flyto2 status
flyto2-runtime flyto2 pair <pairing-code>
flyto2-runtime flyto2 next
```

The `devspace` binary remains as a compatibility alias while this fork stays merge-friendly with upstream.

The same `/mcp` endpoint serves modern MCP clients and the existing compatibility surface. Durable `operation_id` support prevents a lost-response retry from repeating a side effect.

## Usage

Standalone direct-MCP mode:

```text
ChatGPT / Claude -> MCP -> Flyto2 Runtime -> local workspace
```

Optional Flyto2 composition:

```text
ChatGPT -> Flyto2 Cloud -> flyto2.execution.v1 -> Flyto2 Runtime
```

Use `runtime_manifest` to inspect the Runtime identity and provider-neutral capabilities. Use `operation_id` on side-effecting MCP calls when a host may retry after a lost response.

## API / MCP surface

The Runtime keeps the upstream workspace/file/process/review tool surfaces and adds a read-only `runtime_manifest` tool. The optional Cloud bridge uses the public paired-device job lifecycle rather than a Runtime-specific Cloud API. The versioned wire contract lives in `src/flyto2/protocol.ts`.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md). The hard rule is standalone-first: `flyto-runtime` never imports Cloud application code, and Cloud integration is a replaceable adapter over `flyto2.execution.v1`.

## Testing

```bash
TMPDIR=/tmp pnpm test
pnpm typecheck
pnpm lint
pnpm build
flyto-index verify . --full-scan --strict --json
```

On macOS, `TMPDIR=/tmp` avoids the Unix-domain socket path-length limit in the upstream local-agent daemon test.

## License

Flyto2 Runtime remains MIT licensed. The original Waishnav copyright and permission notice are preserved unchanged in [LICENSE](LICENSE). Fork attribution and compatibility notes are in [NOTICE.md](NOTICE.md).

## Contributing

Keep Flyto2-owned runtime behavior in TypeScript under `src/flyto2/` when practical, preserve upstream mergeability, and keep Cloud composition behind the versioned protocol rather than repository imports. Follow [AGENTS.md](AGENTS.md) and run the full verification gates before merging.

## Installation

Flyto2 Runtime requires Node `>=22.19 <27`.

Until a Flyto2 npm release is published, install this fork from source:

```bash
git clone https://github.com/flytohub/flyto-runtime.git
corepack enable
pnpm install
pnpm build
pnpm link --global
```

Then initialize the standalone runtime:

```bash
flyto2-runtime init
```

The compatibility alias remains available:

```bash
devspace init
```

During setup, Flyto2 Runtime asks for:

- where you will use it: ChatGPT, Coding Agents, or both
- which agents DevSpace may use as subagents

The first choice is where you invoke Flyto2 Runtime from. The subagent choice is
separate: ChatGPT or another coding agent can delegate work through the Runtime to
the agents you select there.

If you select ChatGPT, setup also asks which local project folders it may open
and for your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy,
Tailscale Funnel, or another reverse proxy. A Coding Agents-only setup asks
neither question: local commands use the current Git project, or the current
directory outside a repository.

Use the public origin without `/mcp` during setup:

```text
https://your-tunnel-host.example.com
```

You will configure your MCP client with the public `/mcp` URL after setup.
Run `flyto2-runtime serve` (or the `devspace serve` compatibility alias) when using ChatGPT. For Coding Agents, setup prints a
`skills` command and lets the Skills CLI handle installation.

When the client connects, Flyto2 Runtime opens an Owner password approval page. Enter
the Owner password printed by `flyto2-runtime init`. It is also stored in:

```text
~/.devspace/auth.json
```

Keep that password private.

## Configuration

Flyto2 Runtime keeps the upstream DevSpace configuration/state layout for compatibility. Existing `~/.devspace/config.jsonc`, auth state, worktrees, agent profiles, and skills remain valid. Flyto2 Cloud pairing is optional and stores its device credential separately in the Runtime state directory; it is never required for standalone MCP use.

## Connect Your MCP Client

The default local endpoint is:

```text
http://127.0.0.1:7676/mcp
```

Most users should connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
```

> [!NOTE]
> Using DevSpace as an MCP connector isn't against OpenAI's Usage Policies — it's
> a standard custom App/connector setup, and writing or running code isn't a
> restricted use case. But your account is governed by your usage, not by
> DevSpace. Don't point it at anything that would violate your provider's terms.
> Used normally, you're fine. (Based on OpenAI's Usage Policies and Service Terms
> as of June 2026.)

## What ChatGPT Can Do

Once connected, ChatGPT can open one of your approved project folders as a
workspace. From there, it can inspect the repo, make scoped edits, run commands,
and show you what changed.

DevSpace gives ChatGPT tools to:

- read, write, and edit files inside the opened workspace
- search code and inspect directories
- run shell commands for tests, builds, git, and package scripts
- use isolated Git worktrees for parallel coding sessions
- follow project instructions from `AGENTS.md` and `CLAUDE.md`
- discover local agent skills from your skill folders
- show tool cards and optional change summaries in ChatGPT Apps-compatible hosts

## Mental Model

DevSpace is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local
capabilities inside an opened workspace, including shell execution. Treat a
connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `devspace serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open a project inside one of your allowed roots.

## Platform Support

DevSpace supports Linux, macOS, and Windows environments with a Bash-compatible
shell.

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported         | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only              | Not supported yet | Install Git Bash or use WSL.                   |

Run this to inspect your local setup:

```bash
devspace doctor
```

## Documentation

- [Setup Guide](https://github.com/Waishnav/devspace/blob/main/docs/setup.md)
- [ChatGPT Coding Workflow](https://github.com/Waishnav/devspace/blob/main/docs/chatgpt-coding-workflow.md)
- [Configuration Reference](https://github.com/Waishnav/devspace/blob/main/docs/configuration.md)
- [Native File Download](https://github.com/Waishnav/devspace/blob/main/docs/artifact-exchange.md)
- [Security Model](https://github.com/Waishnav/devspace/blob/main/docs/security.md)
- [Troubleshooting Gotchas](https://github.com/Waishnav/devspace/blob/main/docs/gotchas.md)

## Philosophy

Every piece of software is becoming conversational. Natural language is
redefining how we interact with tools, workflows, and systems.

My bet is that ChatGPT becomes the operating system for everything. Once we
reach AGI, we will simply talk to ChatGPT, and it will prompt, coordinate, and
orchestrate sub-agents that set up the right loops for us.

We are not there yet.

DevSpace is one attempt to fast-forward that future: a way for MCP-capable
hosts like ChatGPT and Claude to work directly with local project files through
explicit, inspectable tools.

## Built by Waishnav

I'm Waishnav. I like building opinionated products and tools, and Artifacts is one example.

This year, I began my journey to build a one-person, multi-agent company capable of generating millions in revenue. If you want to follow the failures, wins, lessons, and everything in between, come hang out with me on [X](https://x.com/wshxnv).


## More from me

<table>
  <thead>
    <tr>
      <th>Project</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://gitcms.dev/">
          <img
            src="https://gitcms.dev/brand/gitcms-logo.svg"
            alt="GitCMS"
            width="48"
          /><br />
          <strong>GitCMS</strong>
        </a>
      </td>
      <td>
        <strong>Modern CMS and tooling for markdown based content sites — built for agents and humans.</strong><br><br>
        Visual editing, editorial workflow, and ChatGPT/Claude content agents, with
        every post and page stored as files in your repo.
        <a href="https://gitcms.dev/">Learn more</a>.
      </td>
    </tr>
  </tbody>
</table>

## Local Development

For working on DevSpace itself:

Install pnpm 11.25.0, the version pinned in `package.json`, with
`npm install --global pnpm@11.25.0`, then:

```bash
pnpm install --frozen-lockfile
pnpm dev:seed
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`dev:seed` forks your normal DevSpace config and SQLite state into an ignored
checkout-local `.devspace-dev/` directory so source builds and migrations do not
modify your normal installation. Use `pnpm dev:reset` to discard that QA state
and fork it again. See [Development and Manual QA](docs/development.md) for
worktree switching, ChatGPT, and database-migration workflows.
