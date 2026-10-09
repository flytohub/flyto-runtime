# Flyto2 Runtime mobile gateway (local-first, experimental)

This is a separate, opt-in HTTPS listener for Flyto2 App. Flyto2 Cloud
and the cybersecurity Engine are not required. It reuses the actual
standalone Runtime capability registry; it does not create mock robot or
vehicle capabilities. A phone never receives the same-user Runtime
localhost bridge token.

## Trust and operator setup

1. Generate a TLS private key and certificate on the execution computer.
   Include the private LAN IP in the certificate subjectAltName. Never commit
   private keys or tokens.
2. Explicitly configure the local environment:

       FLYTO2_MOBILE_ENABLE=1
       FLYTO2_MOBILE_HOST=0.0.0.0
       FLYTO2_MOBILE_PORT=8077
       FLYTO2_MOBILE_TLS_CERT=/private/path/mobile-host.crt
       FLYTO2_MOBILE_TLS_KEY=/private/path/mobile-host.key
       FLYTO2_MOBILE_CAPABILITIES=source.read

   The comma-delimited capability allowlist is mandatory. There is no
   default open port, plaintext fallback or app-bundled private key.
3. Start Runtime normally. A separate HTTPS listener starts only when
   the configuration is valid.
4. Runtime prints a certificate SHA-256 fingerprint and an 8-digit, one-use
   pairing code on the local operator console.
5. In the App's local mode, enter the private LAN HTTPS address, fingerprint
   from the local console, and pairing code.

Pairing expires after two minutes or five incorrect attempts. The
session token is random, kept hashed in host memory, and expires after
30 minutes; the App only retains it in memory. Unpair revokes it. Restart
the host to issue a new pairing code.

## Transport

API prefix: /flyto2/mobile/v1

- POST /pair: one-time 8-digit code; returns a time-bounded session token.
- GET /manifest: authenticated live flyto2.execution.v1 manifest, filtered
  to allowed low/medium, non-explicit-approval capabilities.
- POST /invoke: authenticated, manifest-declared and allowlisted invocation.
  Same operation ID/same payload yields original result, different payload
  yields a conflict. No blind actuation replay.
- POST /unpair: revoke the current mobile session.

The result contract distinguishes accepted, success, failed and evidence.
Accepted does not prove independent mission completion.

## Intentional restrictions

Runtime's same-user localhost bridge is not exposed over LAN. The gateway
does not offer shell, MCP credentials, arbitrary workflow construction,
or physically risky/explicit-approval operations. This is a real bridge
for installed Runtime host capabilities, **not** complete standalone
Core AI Space, ROS2 robot execution or verified vehicle integration.

Future work: Core task/approval/evidence composition, real installed
robotics and cockpit providers, independent physical safety, authenticated
session rotation/revocation, mobile pairing UX and device acceptance.

Tests include expired pairing/sessions, unauthorized manifests, unsafe
capability denial, duplicate operations and altered-operation conflicts.
Loopback HTTP in tests is not a production transport.
