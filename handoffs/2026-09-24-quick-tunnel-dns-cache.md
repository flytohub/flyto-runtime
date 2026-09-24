# Quick tunnel DNS wait defeated by negative caching

Owner: claude
Branch: main
Date: 2026-09-24

## What changed

`src/flyto2/quick-tunnel.ts`: `waitForPublicDns` now resolves through
`authoritativeResolve4()`, which looks up the zone's nameservers once and asks
them directly through a `dns.Resolver` created for each attempt. At the deadline
it makes one lookup through the system resolver (`fallbackResolve`) before
failing. `src/flyto2/quick-tunnel.test.ts` asserts the system resolver is not
used while the record is missing, and covers the blocked-direct-DNS fallback.

## Why

Setup's "Create a free Cloudflare URL" failed with "did not appear in public
DNS within 30000 ms" against a tunnel that was working. The first probe ran
before Cloudflare published the hostname and got NXDOMAIN, which is cached for
the zone's negative TTL (1800 s for trycloudflare.com) by two layers: public
resolvers such as 8.8.8.8, and Node's own c-ares channel, which caches misses
per Resolver. Every retry then hit the cache. Querying the authority alone was
not enough; the Resolver object also has to be fresh per attempt. Raising the
timeout or adding monitoring would not help, since the cache outlives both.

## Verified

- Measured against live quick tunnels: the same Resolver reused across retries
  never saw the record within 90 s; a new Resolver per attempt saw it in 4.1 s.
  `dig` against the authority answered in 9 s.
- End to end with the new code, fallback disabled, three fresh `cloudflared`
  quick tunnels: resolved in 6174, 4241 and 6167 ms.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (0 failures),
  `flyto-index verify . --full-scan --strict` (all checks pass).

## Not verified

- A full `flyto2-runtime setup` run that installs the quick tunnel service; only
  the tunnel plus `waitForPublicDns` were exercised.
- The fallback path on a network that actually blocks outbound DNS; it is
  covered by a unit test only.
- The per-attempt Resolver has no unit test; it needs the network, and the live
  comparison above is the evidence.

## Follow-ups

- If DNS never resolves, setup still discards a tunnel that may be working. It
  could keep the URL and let `doctor` confirm it later.
