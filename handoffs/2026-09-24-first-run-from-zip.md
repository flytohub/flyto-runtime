# First run from a downloaded ZIP, with nothing preinstalled but Node

Owner: claude
Branch: main
Date: 2026-09-24

## What changed

- cloudflared no longer needs Homebrew or winget (`src/flyto2/quick-tunnel.ts`,
  `src/flyto2/quick-tunnel-service.ts`, `src/cli.ts`). `cloudflaredSource()`
  picks, in order: an existing install (PATH, Runtime's own `<runtime home>/bin`,
  Homebrew, `~/.local/bin`, winget Links, Program Files); a copy the user
  downloaded into `~/Downloads` (binary or unextracted `.tgz`); the official
  GitHub release asset for the platform. `provideCloudflared()` extracts,
  checks the signature (macOS: `codesign` requirement on Cloudflare's team
  `68WVV388M8`; Windows: `Get-AuthenticodeSignature` valid and signed by
  Cloudflare, Inc.), strips quarantine and installs into `<runtime home>/bin`.
  Setup asks first; `service quick-tunnel start` fetches without asking.
- `Flyto2 Runtime.command` reads PATH from the user's login shell (5 s cap), so
  a double-click finds Node from nvm/fnm/Volta and pnpm from its installer.
- `install` mode on both launchers runs `init` first (a no-op once configured),
  so double-clicking `Install.command` walks a first-time user through setup
  instead of installing an unconfigured service.
- README quick start describes the ZIP + double-click path.

## Why

A real first-time user downloaded the GitHub ZIP (no git), had Node from the
nodejs.org installer, no Homebrew, and could not `npm install -g`. Each step of
the old path assumed one of those.

## Verified

- `provideCloudflared` against the live release, a quarantined downloaded
  binary and a quarantined unextracted `.tgz`: all three installed, ran
  `cloudflared version 2026.9.1`, quarantine removed. An Apple-signed
  non-Cloudflare binary was rejected and nothing was written.
- The Windows release exe carries an Authenticode signature naming
  "Cloudflare, Inc." (read from its PE security directory on macOS).
- Launcher with `env -i` and `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (no node):
  found nvm's node through the login shell, installed, built, exit 0.
- `pnpm lint`, `typecheck`, `test` (0 failures), `build`,
  `test:package-install`, `flyto-index verify . --full-scan --strict`.

## Not verified

- The interactive setup prompt path for cloudflared and `install` mode end to
  end: both install launchd agents on the real account, so they were not run.
- Anything on Windows: `.cmd` changes and the PowerShell signature check.
- Gatekeeper on a double-clicked `.command` from a browser-downloaded ZIP.

## Follow-ups

- Per-platform packaged builds (bundled Node, prebuilt native modules,
  cloudflared, signed and notarized) would remove the Node requirement and the
  build step; `release.yml` already packs and uploads a tarball but has never
  run.
