# Release loop hardening: flaky daemon test, ABI, reproducible app, widget

Owner: claude
Branch: main
Date: 2026-09-24

## What changed

- **Daemon oversized request** (`src/local-agent-daemon.ts`): the daemon
  answered an over-limit request and destroyed the connection while the client
  was still writing, so the client's EPIPE could arrive before (and hide) the
  `DAEMON_INVALID_REQUEST` response. It now half-closes, keeps discarding input
  until the client ends, and destroys after at most 2 s. This was the Intel CI
  flake in `local-agent-daemon.test.ts`; the test's 30 ms request read timeout
  is now 500 ms, which also removed a second flake (`DAEMON_TIMEOUT` instead of
  `DAEMON_INVALID_REQUEST` on a loaded runner).
- **Node ABI** (`Flyto2 Runtime.command`, `.cmd`): source checkouts probe the
  native modules (better-sqlite3 opens a database, since `require` alone does
  not load its binary) and `pnpm rebuild` on a mismatch. macOS then moves a
  background service that runs this checkout to the same Node. The caller's
  PATH now wins over the login shell's, so a Desktop launcher's pinned Node is
  honoured. CI adds `Smoke (macos-latest-node24)`, the Node the app ships, and
  self-update requires it.
- **Reproducible app** (`scripts/package-macos.sh`): cloudflared pinned to
  2026.9.1 with both the archive digest (GitHub) and binary digest (Cloudflare
  release notes) checked; disk image format fixed to ULMO. The default format's
  compression differed per macOS (same app: 208 MB on the runner, 163 MB
  locally); ULMO gives 137 MB.
- **Update notice**: a packaged app reads flyto2's
  `products/runtime/stable.json` and names a newer promoted version in the
  menu and in `doctor` (`checkForAppUpdate`, only `flyto2/releases/tag/` URLs).
- **Apple notarization check** (`.github/workflows/apple-notarization-check.yml`): weekly
  `notarytool history` (reports an unaccepted Apple agreement) and a 60-day
  certificate expiry check.
- **ChatGPT widget** (`src/ui/workspace-app.tsx`): a result without a card
  (a failed tool call) rendered a 45 px "No result card is available" box in
  every such turn. It now renders nothing (0 px).
- Version 1.1.0: tags `v1.0.x` and `v1.1.0-beta.1..4` already exist from the
  upstream history, so 1.0.8 could not be tagged.

## Verified

- Daemon test under full CPU load, x64 Node 22.23.2 via Rosetta with x64
  modules: before 8/25 failed (EPIPE); after the daemon change 60/60 passed.
- ABI: a checkout installed under Node 23 (ABI 131), launched with Node 24
  (ABI 137) first on PATH, rebuilt once, then loaded; the next launch did not
  rebuild. The first probe (`require` only) missed the mismatch and was fixed.
- Widget in a browser with a host harness speaking ui/initialize and
  tool-result: old error result 45 px with the message; new 0 px; an
  open_workspace card still 66 px.
- Local package run: Node checksum, both cloudflared digests, native modules
  under v24.21.0, 137 MB DMG.
- `pnpm lint`, `typecheck`, `test` (0 failures), `build`,
  `test:package-install`, `flyto-index verify . --full-scan --strict`.

## Not verified

- `.cmd` changes and the Windows service after an ABI rebuild.
- Moving an installed macOS service to a new Node (the probe path is tested;
  the reinstall branch did not trigger because no service used that checkout).
- The Apple notarization check until it runs in CI.
