# Launchers build without a pre-installed pnpm

Owner: claude
Branch: main
Date: 2026-09-24

## What changed

- `Flyto2 Runtime.command` and `Flyto2 Runtime.cmd` no longer run
  `corepack enable`. They use a `pnpm` on PATH, else `corepack pnpm`, else
  `npm exec --yes --package=pnpm@<packageManager version> -- pnpm`.
- `package.json` `build` no longer calls `pnpm clean` / `pnpm build:app`, so it
  works when pnpm runs through `corepack pnpm` and is not itself on PATH.
- `src/flyto2/pnpm-command.ts`: the same resolution for self-update
  (`SelfUpdateDeps.pnpm` is now an argv prefix; `src/cli.ts` passes
  `resolvePnpm()`).
- README quick start uses `npx --yes pnpm@11.25.0` instead of `corepack enable`.

## Why

A first-time user has Node but not pnpm, and the launcher's only recovery was
`corepack enable`. That writes shims next to node, which is root-owned for the
nodejs.org installer (`/usr/local`), and Node 25+ ships no corepack. The same
users cannot `npm install -g pnpm` either (EACCES on `/usr/local/lib/node_modules`,
seen on a real MacBook Air). Nightly self-update had the same plain `pnpm`
assumption.

## Verified

Fresh copies of the tree, `env -i` with a PATH holding only the listed binaries,
running `Flyto2 Runtime.command doctor` from no `node_modules` / no `dist`:
- node + npm only: installed with pnpm 11.25.0, built `dist/cli.js`, exit 0.
- node + corepack only, bin dir read-only: same, exit 0 (this case first failed
  on the nested `pnpm` in the build script; fixed).
- node only: clear failure message, exit 1.
`pnpm lint`, `typecheck`, `test` (0 failures), `build`, `test:package-install`,
`flyto-index verify . --full-scan --strict` all pass.

## Not verified

- `Flyto2 Runtime.cmd` was not run; no Windows machine. Its `for /f` version
  read and `call %PNPM%` expansion are untested. A static test checks both
  launchers share the resolution order.
- Self-update with the npm-exec fallback was not run end to end.

## Follow-ups

- A Windows CI step that runs `Flyto2 Runtime.cmd` without pnpm would close the
  gap above.
