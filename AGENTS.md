# Flyto2 Runtime

Flyto2 Runtime is the standalone local execution layer for MCP hosts such as ChatGPT and Claude. It remains an MIT-licensed fork of `Waishnav/devspace`.

## Product boundary

- Runtime must work without Flyto2 Cloud.
- Cloud integration stays optional and behind the versioned Flyto2 execution protocol / public device-job APIs.
- Runtime core must not import Cloud application modules, tenancy, billing, War Room state, or hosted persistence.
- Preserve the upstream MIT notice and practical compatibility surfaces such as the `devspace` CLI alias and existing state layout unless an explicit migration replaces them.
- New Runtime behavior belongs in TypeScript source, not compiled-JavaScript patches.

The host orchestrates. Runtime exposes small, composable workspace, file, process, Git, review, artifact, and bounded local-agent primitives. Durable jobs, events, recovery, watches, and service/tunnel mechanics are Runtime internals and should stay off the normal model-facing surface.

## Before changing source

For non-trivial changes:
1. Before changing code, perform a pre-change search and impact/context exploration with `flyto-index` for affected symbols and dependencies.
2. Read `PROJECT.md` and `ARCHITECTURE.md` when the Runtime/Cloud boundary is relevant.
3. Preserve unrelated user changes.
4. After editing, run relevant tests, typecheck/build, and `flyto-index verify . --full-scan --strict --json`. Do not lower verification thresholds to make a change pass.

## Core terms

- **Host** — MCP client coordinating work.
- **Runtime** — the local Flyto2 MCP server.
- **Workspace** — one opened checkout or isolated worktree plus its accumulated context.
- **Allowed root** — filesystem admission boundary; not necessarily a workspace.
- **Checkout mode** — work directly in the user's checkout.
- **Worktree mode** — work in an isolated Git worktree.
- **Process session** — long-running command continued by opaque session ID.
- **Instruction file** — applicable `AGENTS.md` or `CLAUDE.md`.
- **Subagent** — bounded delegated model invocation.
- **Artifact** — user-provided/generated file transferred through the supported artifact path.
- **Review checkpoint** — Git-backed state for coherent change review.

Use these terms precisely.

## Security and correctness

Filesystem tools must enforce allowed-root containment. Shell execution runs with the local user's authority and is not a sandbox.

Resolve and validate paths before destructive actions. Do not broaden allowed roots, expose credentials, replace processes, or delete state as a convenience fix.

Keep tunnel ownership and credentials with the user. Diagnose failures at the correct layer: host, MCP transport, Runtime, adapter/provider, model, tool implementation, or target project. Preserve original errors instead of masking them.

A successful command does not prove a host refreshed, a GUI opened, or a user-visible workflow succeeded. Verify the path the user actually consumes: source vs packaged install, direct client vs real MCP host, fresh vs cached host catalog, checkout vs worktree, and supported OSes.

## Model-facing surface

Keep tool schemas and results small. Do not expose implementation controls that Runtime can own internally.

Normal Codex mode should center on:
- `open_workspace`
- `read`
- `apply_patch`
- `exec_command`
- `write_stdin`
- `show_changes`

Runtime does not advertise MCP Apps/result cards. `show_changes` returns a compact review reference/summary; full patches stay in local Git-backed review history and are fetched only when explicitly needed.

Open a project/worktree once, then reuse its `workspace_id`. Avoid duplicating discovery context, large command output, diffs, logs, or evidence in model responses.

## Cross-cutting changes

When changing a concept, trace the surfaces it actually reaches:
- MCP schema/handler/result
- workspace lifecycle and instruction loading
- path containment
- checkout/worktree lifecycle and cleanup
- process/subagent lifecycle
- persistence and migrations
- artifacts/review checkpoints
- packaged entry points, docs, and examples

Touch only relevant surfaces; avoid both incomplete contracts and speculative edits.

## Git and pull requests

Do not use `cd <dir> && git ...`; use `git -C <dir> ...` when operating outside the current workspace.

Create or update a PR only when explicitly asked, and read `CONTRIBUTING.md` first. Keep each PR focused. Use conventional titles (`fix:`, `feat:`, `docs:`, `refactor:`, `chore:`) and describe the problem, solution, verification, and material risk without generated boilerplate.

## Code map

- `src/server.ts` — HTTP/MCP server and surface composition
- `src/mcp-workspace-tools.ts` — workspace/read/review MCP tools
- `src/workspaces.ts` — workspace lifecycle, instructions, skills, profiles
- `src/roots.ts` — allowed roots/path containment
- `src/process-sessions.ts` — process lifecycle and bounded output
- `src/git.ts`, `src/git-worktrees.ts` — Git/worktree operations
- `src/review-checkpoints.ts` — Git-backed review history
- `src/local-agent-*.ts` — local-agent adapters/execution
- `src/artifact-*.ts`, `src/incoming-artifacts.ts` — artifact transfer
- `src/flyto2/` — versioned Flyto2 protocol, optional Cloud bridge, durable Runtime internals
- `src/db/` — persisted local state/migrations
- `test/`, `src/**/*.test.ts` — behavior/regression tests

Prefer explicit state, bounded output, recoverable side effects, and boring reliable primitives over hidden autonomy or host-specific decoration.
