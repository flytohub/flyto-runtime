# Flyto2-owned Runtime modules

This directory contains the Flyto2-specific TypeScript surface layered onto the upstream DevSpace fork.

- `protocol.ts`: provider-neutral `flyto2.execution.v1` schemas.
- `manifest.ts`: standalone Runtime identity and capability manifest.
- `cloud-bridge.ts`: optional outbound Flyto2 Cloud pairing/job transport.
- `connected-runtime.ts`: dependency-injected claim/lease/progress/completion loop.
- `durable-operations.ts`: SQLite-backed exactly-once operation admission/replay.
- `durable-tools.ts`: MCP registration wrapper that adds `operation_id` to side-effecting tools.

The Runtime core remains usable when the Cloud bridge is absent. Flyto2 modules must not import Flyto2 Cloud application code.
