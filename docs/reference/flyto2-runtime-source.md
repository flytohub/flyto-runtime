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

- [`ConnectedFlyto2Runtime`](../../src/flyto2/connected-runtime.ts#L59) — dependency-injected Cloud composition loop for claim, lease, progress, execution and completion.
- [`abortableDelay`](../../src/flyto2/connected-runtime.ts#L205)

## Durable operations

- [`DurableOperationStore`](../../src/flyto2/durable-operations.ts#L23) — SQLite-backed atomic admission and durable replay state.
- [`runDurableOperation`](../../src/flyto2/durable-operations.ts#L127)
- [`validateOperationId`](../../src/flyto2/durable-operations.ts#L155)
- [`durableFingerprint`](../../src/flyto2/durable-operations.ts#L163)
- [`stableValue`](../../src/flyto2/durable-operations.ts#L169)
- [`durableOperationFromRow`](../../src/flyto2/durable-operations.ts#L179)

## Durable MCP tool wrapper

- [`withDurableToolHandlers`](../../src/flyto2/durable-tools.ts#L20) — adds optional `operation_id` idempotency to side-effecting MCP tools and suppresses completion hooks on replay.
- [`shouldJournalTool`](../../src/flyto2/durable-tools.ts#L79)
- [`asRecord`](../../src/flyto2/durable-tools.ts#L85)

## macOS launcher

- [`flyto2RuntimePackageRoot`](../../src/flyto2/macos-launcher.ts#L11) — resolves the installed/source package root used by the launcher manager.
- [`installMacDesktopLaunchers`](../../src/flyto2/macos-launcher.ts#L15) — installs Finder-friendly Desktop `.command` shortcuts that all enter the same TypeScript Runtime CLI.
- [`removeMacDesktopLaunchers`](../../src/flyto2/macos-launcher.ts#L58)
- [`macDesktopLauncherStatus`](../../src/flyto2/macos-launcher.ts#L69)
- [`shellQuote`](../../src/flyto2/macos-launcher.ts#L79)

## Runtime manifest

- [`runtimeManifest`](../../src/flyto2/manifest.ts#L33) — standalone provider-neutral Flyto2 Runtime capability manifest, including event/evidence/reactive execution capabilities.
- [`runtimeId`](../../src/flyto2/manifest.ts#L47)
- [`capability`](../../src/flyto2/manifest.ts#L62)

## Flyto2 execution protocol

- [`normalizeCloudJob`](../../src/flyto2/protocol.ts#L66) — maps the existing Cloud job shape into `flyto2.execution.v1`.
- [`inferAssignmentKind`](../../src/flyto2/protocol.ts#L91)
- [`stringField`](../../src/flyto2/protocol.ts#L97)

## Reactive command runner

- [`ReactiveCommandRunner`](../../src/flyto2/reactive-command.ts#L71) — starts non-interactive commands without model polling, stores bounded local evidence, emits shallow completion facts, and marks interrupted jobs orphaned on restart.
- [`reactiveEnvironment`](../../src/flyto2/reactive-command.ts#L393)
- [`normalizeEventType`](../../src/flyto2/reactive-command.ts#L417)
- [`evidenceRefForJob`](../../src/flyto2/reactive-command.ts#L423)
- [`jobIdFromEvidenceRef`](../../src/flyto2/reactive-command.ts#L427)
- [`evidenceMetadata`](../../src/flyto2/reactive-command.ts#L434)
- [`reactiveJobFromRow`](../../src/flyto2/reactive-command.ts#L448)

## Durable Runtime event stream

- [`RuntimeEventStore`](../../src/flyto2/runtime-events.ts#L63) — durable monotonic event stream with dedupe, cursor recovery, filtering, bounded retention, and one-shot waits.
- [`normalizeEventInput`](../../src/flyto2/runtime-events.ts#L211)
- [`matchesNormalizedEvent`](../../src/flyto2/runtime-events.ts#L242)
- [`runtimeEventFromRow`](../../src/flyto2/runtime-events.ts#L257)
- [`normalizeSequence`](../../src/flyto2/runtime-events.ts#L272)
- [`normalizeLimit`](../../src/flyto2/runtime-events.ts#L280)
- [`normalizeWait`](../../src/flyto2/runtime-events.ts#L288)
- [`boundedToken`](../../src/flyto2/runtime-events.ts#L296)
- [`optionalToken`](../../src/flyto2/runtime-events.ts#L304)

## MCP-to-event bridge

- [`emitDurableToolEvent`](../../src/flyto2/tool-events.ts#L6) — turns successful durable MCP mutations into shallow Runtime events while avoiding replay duplication.
- [`structuredContent`](../../src/flyto2/tool-events.ts#L63)
- [`stringField`](../../src/flyto2/tool-events.ts#L70)
- [`numberField`](../../src/flyto2/tool-events.ts#L78)
- [`booleanField`](../../src/flyto2/tool-events.ts#L86)
