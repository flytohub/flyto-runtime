# Flyto2 Runtime

**Flyto2 Runtime** is a local execution runtime for ChatGPT, Claude, coding agents, and Flyto2.

It solves a simple problem: AI can reason about code, but it still needs a reliable way to work with local files, Git, tests, builds, processes, and long-running tasks.

## What it does

- Connects AI clients to local workspaces through MCP
- Reads, edits, tests, builds, and works with Git
- Runs long tasks without model polling
- Uses durable operation IDs to avoid duplicated side effects
- Keeps large logs local and exposes evidence only when needed
- Supports optional Flyto2 Cloud pairing
- Includes a one-click macOS launcher

## Quick start

```bash
git clone https://github.com/flytohub/flyto-runtime.git
cd flyto-runtime
corepack enable
pnpm install
pnpm build
```

On macOS, double-click:

```text
Install.command
```

Then launch **Flyto2 Runtime** from the Desktop.

## Roadmap

Flyto2 Runtime will connect with **Flyto2 Core** to extend local execution into reusable capabilities such as:

- Web crawling
- Browser testing
- Automated validation
- Security testing
- Agent-driven workflows

It can run standalone or connect to Flyto2 Cloud when orchestration is needed.

## License

MIT. This project is based on [Waishnav/devspace](https://github.com/Waishnav/devspace). The original copyright and license notice are preserved in [LICENSE](LICENSE).
