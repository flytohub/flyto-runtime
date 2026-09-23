# Flyto2 Runtime

**Give ChatGPT secure access to your machine. Turn ChatGPT into Codex.**

ChatGPT can tell you what to change. **Flyto2 Runtime lets it actually do the work.**

No more copying files into chat, pasting commands into a terminal, sending the error back, and repeating the loop. Connect ChatGPT to your own machine over MCP and let it open your real project, edit code, run commands, test the result, use Git, and show you what changed.

Your machine stays the execution environment. You choose which project folders it can access.

## Why Flyto2 Runtime?

Without a local runtime, coding with ChatGPT often looks like this:

```text
ChatGPT suggests code
        ↓
you copy it into the repo
        ↓
you run the command
        ↓
it fails
        ↓
you paste the error back
        ↓
repeat
```

With Flyto2 Runtime:

```text
You ask ChatGPT
        ↓
ChatGPT opens your project
        ↓
edits → runs → tests → fixes
        ↓
shows you the result
```

That is the point of Flyto2 Runtime: **close the loop between the AI and your machine.**

## What it gives ChatGPT

Once connected, ChatGPT can work inside an approved local workspace and:

- read and edit your project files
- run terminal commands, tests, builds, Git, and package scripts
- keep long-running work alive without making you babysit the terminal
- review what changed before you continue
- work through OAuth instead of exposing an unauthenticated local shell
- optionally hand work to local coding agents or connect to Flyto2 Cloud

The normal model-facing surface stays intentionally small. Runtime handles process recovery, durable execution, filesystem events, service lifecycle, and tunnel supervision behind the scenes.

## Quick start

Requirements:

```text
Node >=22.19 <27
Git
Bash / Git Bash / WSL
```

Clone and build:

```bash
git clone https://github.com/flytohub/flyto-runtime.git
cd flyto-runtime
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Then run setup:

```bash
flyto2-runtime init
```

On macOS you can double-click `Install.command`. On Windows, double-click `Install.cmd`. Flyto2 Runtime installs a native background service and Desktop launchers so you do not need to keep a terminal window open.

## Connect ChatGPT

ChatGPT needs a public HTTPS URL that reaches your local Runtime.

During setup, choose **ChatGPT** and enter your public Runtime URL:

```text
https://your-runtime-host.example.com
```

Flyto2 Runtime exposes MCP at:

```text
https://your-runtime-host.example.com/mcp
```

Setup can also generate an upload-ready ChatGPT Plugin ZIP for you.

Choose:

```text
Generate an upload-ready ChatGPT Plugin ZIP now?
Yes / No
```

If you choose **Yes**, Runtime creates the ZIP from **your own configured MCP URL**. Nothing is hard-coded to a Flyto2 hostname.

If you choose **No**, you can create it later:

```bash
flyto2-runtime plugin build
```

The ZIP contains only portable Plugin metadata, MCP configuration, and a small Runtime skill. It does **not** contain your Owner password, OAuth tokens, tunnel credentials, or `auth.json`.

Need a custom package for another machine or deployment?

```bash
flyto2-runtime plugin build \
  --url https://runtime.example.com/mcp \
  --name my-runtime \
  --server-name my-runtime \
  --display-name "My Runtime" \
  --output ./my-runtime-plugin.zip
```

Upload the ZIP in ChatGPT Plugins, approve the OAuth connection, and start working.

## The workflow

A normal session is intentionally simple:

```text
ChatGPT
   ↓
OAuth + MCP
   ↓
Flyto2 Runtime
   ↓
your approved local workspace
   ↓
files / Git / terminal / tests / builds
```

Flyto2 Cloud is optional. Flyto2 Runtime works standalone.

## Desktop and background service

Flyto2 Runtime is designed to stay available after setup.

**macOS:** a LaunchAgent keeps Runtime running in the background.

**Windows:** Task Scheduler starts Runtime at login and a small supervisor restarts it if the process exits unexpectedly.

Useful commands:

```bash
flyto2-runtime doctor
flyto2-runtime service status
flyto2-runtime service start
flyto2-runtime service restart
flyto2-runtime service stop
```

The interactive launcher also includes setup, diagnostics, and **Export ChatGPT plugin**.

### Updating a machine you are not sitting at

```bash
flyto2-runtime service self-update
flyto2-runtime service self-update status
```

`self-update` returns immediately, so ChatGPT or any other connected host can run it through its shell tool. A separate job owned by launchd (macOS) or Task Scheduler (Windows) then:

1. fetches `main` from `github.com/flytohub/flyto-runtime` (the source is fixed; it cannot be pointed elsewhere);
2. refuses the commit unless every CI check on it finished green;
3. builds it in its own directory, never in your checkout;
4. switches the background service to that build and restarts it behind the `/healthz` gate, rolling back to the previous build if the check fails.

The connection drops for a few seconds during the restart. OAuth approvals survive it, so the host reconnects without asking for the Owner password again, as long as its URL does not change. Use a named Cloudflare tunnel with a fixed hostname; a quick `trycloudflare.com` tunnel gets a new URL whenever it restarts.

## Security

Flyto2 Runtime is powerful because it can operate on your machine. Treat a connected AI client like a trusted coding partner.

Access is restricted to the workspace roots you approve. Remote MCP access uses OAuth. Keep your Owner credential, tunnel credentials, and `auth.json` private.

Flyto2 Runtime does not pretend shell execution is a full OS sandbox. The security boundary is explicit workspace scope, authenticated access, and the permissions of the local user running Runtime.

See [Security Model](docs/security.md) for details.

## Built for real local work

The parts you should not have to think about are handled by Runtime: long-running commands, lost responses, process continuation, filesystem changes, service restarts, health checks, MCP compatibility, and recovery.

Those are implementation details, not the product.

The product is simpler:

> **Ask ChatGPT to work on your project, and let it finish the job on your machine.**

## Documentation

- [Setup Guide](docs/setup.md)
- [ChatGPT Coding Workflow](docs/chatgpt-coding-workflow.md)
- [Configuration Reference](docs/configuration.md)
- [Security Model](docs/security.md)
- [Troubleshooting](docs/gotchas.md)

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
flyto-index verify . --full-scan --strict --json
```

## Roadmap

Flyto2 Runtime will also connect with **Flyto2 Core** for reusable capabilities such as browser testing, crawling, automated validation, security testing, and agent-driven workflows.

## License

MIT.

Flyto2 Runtime is based on [Waishnav/devspace](https://github.com/Waishnav/devspace). The original copyright and license notice are preserved in [LICENSE](LICENSE).
