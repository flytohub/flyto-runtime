# Flyto2 Runtime source reference

This reference documents the Flyto2-owned TypeScript surface layered on the upstream DevSpace fork. Upstream-owned source remains covered by the upstream test/typecheck/build suite and is intentionally excluded from Flyto2 source-reference scoring so upstream merges do not become artificial Flyto2 documentation debt.

## Cloud bridge

- [`Flyto2CloudBridge`](../../src/flyto2/cloud-bridge.ts#L52) — optional outbound pairing/job transport over the existing Flyto2 Cloud device boundary.
- [`normalizeCloudUrl`](../../src/flyto2/cloud-bridge.ts#L295)
- [`requiredString`](../../src/flyto2/cloud-bridge.ts#L306)
- [`optionalString`](../../src/flyto2/cloud-bridge.ts#L312)
- [`ensureSuccess`](../../src/flyto2/cloud-bridge.ts#L317)
- [`jitter`](../../src/flyto2/cloud-bridge.ts#L326)
- [`delay`](../../src/flyto2/cloud-bridge.ts#L330)
- [`isAbortError`](../../src/flyto2/cloud-bridge.ts#L343)

## Connected Runtime

- [`ConnectedFlyto2Runtime`](../../src/flyto2/connected-runtime.ts#L57) — dependency-injected Cloud composition loop for claim, lease, progress, execution and completion.
- [`abortableDelay`](../../src/flyto2/connected-runtime.ts#L154)

## Durable operations

- [`DurableOperationStore`](../../src/flyto2/durable-operations.ts#L23) — SQLite-backed atomic admission and durable replay state.
- [`runDurableOperation`](../../src/flyto2/durable-operations.ts#L127)
- [`validateOperationId`](../../src/flyto2/durable-operations.ts#L155)
- [`durableFingerprint`](../../src/flyto2/durable-operations.ts#L163)
- [`stableValue`](../../src/flyto2/durable-operations.ts#L169)
- [`durableOperationFromRow`](../../src/flyto2/durable-operations.ts#L179)

## Durable MCP tool wrapper

- [`withDurableToolHandlers`](../../src/flyto2/durable-tools.ts#L10) — adds optional `operation_id` idempotency to side-effecting MCP tools.
- [`shouldJournalTool`](../../src/flyto2/durable-tools.ts#L61)
- [`asRecord`](../../src/flyto2/durable-tools.ts#L67)

## Runtime manifest

- [`runtimeManifest`](../../src/flyto2/manifest.ts#L29) — standalone provider-neutral Flyto2 Runtime capability manifest.
- [`runtimeId`](../../src/flyto2/manifest.ts#L43)
- [`capability`](../../src/flyto2/manifest.ts#L58)

## Flyto2 execution protocol

- [`normalizeCloudJob`](../../src/flyto2/protocol.ts#L66) — maps the existing Cloud job shape into `flyto2.execution.v1`.
- [`inferAssignmentKind`](../../src/flyto2/protocol.ts#L91)
- [`stringField`](../../src/flyto2/protocol.ts#L97)
