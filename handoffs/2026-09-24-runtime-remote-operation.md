# Cached ChatGPT compatibility, setup closure, self-update, quick tunnel

Owner: claude
Branch: main
Date: 2026-09-24

## What changed

All on `main`, from `f130b9f` to `1106e53`.

- **Cached ChatGPT catalogs on the Codex surface** (`src/mcp-legacy-codex-writes.ts`, `src/mcp-legacy-input.ts`, `src/server.ts`, `src/tool-surfaces/codex.ts`). Legacy `write`/`edit` become one `apply_patch` at the transport: `edit` keeps the exact-unique-match contract and widens matches to whole-line hunks; `write` is byte-exact via Add File's no-newline marker. A retried call with the same `operation_id` replays the first translation from a journal entry keyed by a hash of that id. Legacy `bash` is marked with the internal `x-flyto2-legacy-shell` header (stripped from incoming requests); `exec_command`/`write_stdin` then wait up to 45s and describe continuation as `bash` with `@flyto2/job <session> [--cancel]`, which routes to `write_stdin`.
- **`0009d7e` (a parallel implementation of the same fixes) was merged over, not reverted.** Its `edit` translation failed every partial-line edit and applied an ambiguous `old_text` to its first match; its setup screen showed the password in plaintext and reported a loaded launchd job as running. Kept from it: Add File no-newline support and its HTTP test.
- **Setup ends on a status screen** (`src/setup-completion.ts`, `src/cli.ts`): local health, public endpoint and background service reported separately; MCP URL and Owner password together (masked unless new); clipboard over stdin; start/restart behind a health wait. A health reply from another server is reported as "port held by another program". `doctor` reports the same service state and local health.
- **`open_workspace` names the allowed roots** in its path description and in access denials, so a host opens a root and lists it instead of searching `$HOME`.
- **Setup never defaults the project folder to the Runtime's own directory** (the launcher `cd`s into it) or to the whole home directory.
- **`service self-update`** (`src/flyto2/self-update.ts`, `self-update-scheduler.ts`): schedules a one-shot launchd agent / Task Scheduler task that fetches `main` from the fixed repository, refuses any commit without fully green check runs, builds in `<runtime home>/self-update/builds/<sha>`, and switches the service through the existing health-gated restart with rollback. `service self-update status` reports phases. Server instructions give a managed service's host the absolute command.
- **Free Cloudflare URL in setup** (`src/flyto2/quick-tunnel.ts`, `quick-tunnel-service.ts`): default choice installs `cloudflared` with consent, runs a kept-alive quick tunnel (metrics on 127.0.0.1:20243), reads the hostname from `/quicktunnel`, and waits until it resolves in DNS before anything probes it. The managed Runtime polls the live hostname, saves it and exits 75 so the service manager restarts it with the new Host/OAuth resource. `service quick-tunnel start|stop|status`.
- `service uninstall` on macOS also removes the `.active` / `.previous` plist copies.
- CI: `macos-15-intel` added; macOS/Windows jobs set `FLYTO2_NATIVE_SERVICE_TESTS=1` to run `src/flyto2/native-jobs.integration.test.ts` against the real service manager.

## Why

The user operates this Runtime remotely through ChatGPT. Every failure today traced to state the host could not see: a cached tool catalog, a legacy DevSpace kit holding port 7676 while `doctor` said the service was "running", an unknown allowed root, a random URL that changed on restart, and no way to update without walking back to the machine.

Rejected: a Flyto2-hosted relay handing out subdomains (the repo keeps tunnel ownership with the user), and updating from GitHub Releases (none has ever been published).

## Verified

- Every commit: `pnpm lint`, `pnpm typecheck`, `pnpm test` (269 tests, 0 fail at `1106e53`), `pnpm build`, `pnpm test:package-install`, `flyto-index verify . --full-scan --strict --json` (20/20). GitHub CI green on ubuntu/macOS/Windows through `1890fc4`.
- On an Apple M5 / macOS 26.6.2: a real `service self-update` moved the live service to a clean build and the public URL recovered; the CI gate refused a commit with a pending check. The native integration tests pass against real launchd.
- Quick tunnel on the same machine: launchd-run cloudflared, public `/healthz` reached the Runtime, `/mcp` without a token returned 401; killing cloudflared produced a new URL that the Runtime saved before exiting 75.
- A fresh `git clone` of `1890fc4` → `pnpm install` → `pnpm build` → setup driven in a pty (ChatGPT, free URL, Start Runtime) ended on "Setup complete" with Runtime, public endpoint and background service all `[ok]`.

- The flyto-indexer MCP `task(action='validate')` is pinned to the flyto-indexer checkout and runs ruff/pytest, which do not apply to this TypeScript repository; the repository's own checks plus the CLI `flyto-index verify --strict` stand in for it.

## Not verified

- A real ChatGPT session against this machine after the reset. Everything ChatGPT exercised today ran on the user's other Mac.
- Windows and Intel macOS on real hardware; only CI covers them (the native tests there were added in `1106e53`).
- ChatGPT's own confirmation prompt on `edit` is host behavior and was not changed.

## Follow-ups

- Machine state: the user's MacBook Pro was reset on 2026-09-23 to a first-install state; backup at `~/flyto2-runtime-backup-20260923-235802`. The legacy kit (`local.devspace.mac-kit`) is `launchctl disable`d there.
- The user's second Mac (repo at `/Users/chester/flytohub`) serves `devspace.flyto2.com`; its Runtime version is unknown. It can take `service self-update` only if it already runs `5f0dfd8` or later.
- Two machines must never run the same named tunnel; Cloudflare would split traffic between them.
- `feat/cloud-core-executor` (remote only) was reviewed and kept: additive executor/adapter-provider work consistent with ARCHITECTURE.md, conflicts in `src/cli.ts`, and it starts a Cloud execution loop in `serve()`, which is a product decision.
