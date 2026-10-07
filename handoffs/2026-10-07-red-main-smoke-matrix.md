# Red main CI: Windows EBUSY and timing-dependent process tests

Owner: claude
Branch: claude/runtime-ci-flakes
Date: 2026-10-07

## What changed

- `src/flyto2/runtime-events.test.ts`: the correlation-envelope test registered
  two `t.after` hooks. Node runs them in registration order, so the directory
  was removed while the reopened store still held `devspace.sqlite` open.
  macOS/Linux allow that; Windows fails with `EBUSY`. One hook now closes every
  handle and then removes the directory.
- `src/server.test.ts`: six tests waited a fixed time (600 ms to 2 s) and then
  asserted the child had exited. On `macos-15-intel` and Windows, Node startup
  plus the child's own timer regularly outlasted the sleep. They now read the
  non-waiting snapshot (`process_status` / `@flyto2/job`) until it is terminal,
  with a 20 s deadline (`eventually`, `waitForProcessExit`). The assertions that
  `process_status` never waits and that `exec_command` yields are unchanged.

## Why

CI on `main` had been red since 2026-09-30 (runs 36732444791, 36738139603,
36797936410, 36817564533). Windows failed every time on the EBUSY above; macOS
Intel failed on one of the Codex `exec_command` tests each time. Earlier fixes
had raised the sleeps; that only moves the threshold. Product code is unchanged.

## Verified

- `pnpm lint`, `pnpm typecheck`: pass.
- `pnpm test` (macOS arm64, local): 366 tests, 362 pass, 0 fail.
- `flyto-index verify . --full-scan --strict --json`: 20 pass, 0 warn, 0 fail.
- Node `t.after` order confirmed FIFO with a two-hook probe on Node 23.

## Not verified

- The EBUSY cannot be reproduced on macOS; the Windows proof is the PR's
  `Smoke (windows-latest)` job.

## Follow-ups

None.
