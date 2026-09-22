# Flyto2-owned Runtime modules

This directory contains the Flyto2-specific TypeScript surface layered onto the upstream DevSpace fork.

- `protocol.ts`: provider-neutral `flyto2.execution.v1` schemas.
- `manifest.ts`: standalone Runtime identity and capability manifest.
- `cloud-bridge.ts`: optional outbound Flyto2 Cloud pairing/job transport.
- `connected-runtime.ts`: dependency-injected claim/lease/progress/completion loop.
- `durable-operations.ts`: SQLite-backed exactly-once operation admission/replay.
- `durable-tools.ts`: MCP registration wrapper that adds `operation_id` to side-effecting tools.
- `runtime-events.ts`: durable monotonic Runtime event stream with cursor recovery, dedupe, filtering, bounded retention, and one-shot waits.
- `reactive-command.ts`: detached non-interactive command runner that stores bounded local evidence and emits shallow completion events.
- `tool-events.ts`: converts completed durable MCP mutations into shallow Runtime events without replay duplication.

The Runtime core remains usable when the Cloud bridge is absent. Flyto2 modules must not import Flyto2 Cloud application code.
