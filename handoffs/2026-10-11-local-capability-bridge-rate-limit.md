# 2026-10-11 — Local capability bridge request throttling

Task: `RT-20261011-CODEQL-BRIDGE-RATE-LIMIT`

Base: `e57031ecb5461a85bfc1cd6be623417d7eb36fc0` (`origin/main`).
Independent worktree: `flyto-runtime-57c169a5`; other worktrees unchanged.

## Scope

- CodeQL High alerts #12 and #13 identify missing request rate limiting on
  `/flyto2/capabilities/v1/manifest` and `/invoke`.
- Both local-only, token-authenticated routes now use one in-memory,
  per-client `express-rate-limit` budget (240 requests per 60 seconds).
- The limit runs before route authorization and transport dispatch, counts
  unsuccessful authentication attempts, and returns HTTP 429 when exceeded.
- The existing loopback, Host header, constant-time token comparison, and
  invocation schema validation remain unchanged.
- Tests assert that both endpoints expose the standard rate-limit header.
- The main server's global JSON parser currently precedes route registration.
  This change does **not** claim to throttle malformed JSON before parsing;
  pre-parser admission should be assessed separately before declaring the
  entire HTTP ingress hardened.

## Evidence and remaining gates

- Focused local bridge test: 1 passed, 0 failed.
- TypeScript typecheck: PASS; architecture lint: PASS; build: PASS.
- Indexer full-scan strict: 20 PASS, 0 WARN, 0 FAIL.
- Full Runtime test suite: 390 total, 386 passed, 4 skipped, 0 failed
  after repairing isolated native addon build prerequisites. The earlier
  incomplete native-install attempt failed; it is not counted as a pass.
- GitHub CodeQL alert resolution: NOT YET PROVEN. PR and remote CI pending.
- Commit attempt was blocked by the connected execution tool's safety check.
  The complete change is staged in the isolated branch, but HEAD is still the
  base SHA above. No alternate commit mechanism or GitHub write was attempted.
- Historical `gitleaks git` scan reported two findings in existing commit
  history; scoped current-source and handoff directory scans found no leaks.
  No historical findings were suppressed or dismissed in this task.
- No merge, deployment, local app replacement, hardware acceptance, or SPM scan.

Next: finish full tests; review diff; commit isolated changes; open focused PR
when allowed; verify CodeQL and five-platform CI on the exact head SHA before
considering merge. Keep SPM Production scanning HOLD.
