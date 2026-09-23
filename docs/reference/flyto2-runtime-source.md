# Flyto2 Runtime source reference

This reference documents the Flyto2-owned TypeScript surface layered on the upstream DevSpace fork. Upstream-owned source remains covered by the upstream test/typecheck/build suite and is intentionally excluded from Flyto2 source-reference scoring so upstream merges do not become artificial Flyto2 documentation debt.

## Cloud bridge
- [`Flyto2CloudBridge`](../../src/flyto2/cloud-bridge.ts#L52)
- [`normalizeCloudUrl`](../../src/flyto2/cloud-bridge.ts#L295)
- [`requiredString`](../../src/flyto2/cloud-bridge.ts#L306)
- [`optionalString`](../../src/flyto2/cloud-bridge.ts#L312)
- [`ensureSuccess`](../../src/flyto2/cloud-bridge.ts#L317)
- [`jitter`](../../src/flyto2/cloud-bridge.ts#L326)
- [`delay`](../../src/flyto2/cloud-bridge.ts#L330)
- [`isAbortError`](../../src/flyto2/cloud-bridge.ts#L343)

## Connected Runtime
- [`ConnectedFlyto2Runtime`](../../src/flyto2/connected-runtime.ts#L59)
- [`abortableDelay`](../../src/flyto2/connected-runtime.ts#L205)

## Durable operations
- [`DurableOperationStore`](../../src/flyto2/durable-operations.ts#L23)
- [`runDurableOperation`](../../src/flyto2/durable-operations.ts#L127)
- [`validateOperationId`](../../src/flyto2/durable-operations.ts#L155)
- [`durableFingerprint`](../../src/flyto2/durable-operations.ts#L163)
- [`stableValue`](../../src/flyto2/durable-operations.ts#L169)
- [`durableOperationFromRow`](../../src/flyto2/durable-operations.ts#L179)

## Durable MCP tool wrapper
- [`withDurableToolHandlers`](../../src/flyto2/durable-tools.ts#L20)
- [`shouldJournalTool`](../../src/flyto2/durable-tools.ts#L79)
- [`asRecord`](../../src/flyto2/durable-tools.ts#L85)

## macOS launcher
- [`flyto2RuntimePackageRoot`](../../src/flyto2/macos-launcher.ts)
- [`installMacDesktopLaunchers`](../../src/flyto2/macos-launcher.ts)
- [`removeMacDesktopLaunchers`](../../src/flyto2/macos-launcher.ts)
- [`macDesktopLauncherStatus`](../../src/flyto2/macos-launcher.ts)

## Native desktop lifecycle
- [`native-service.ts`](../../src/flyto2/native-service.ts) — dispatches the same service lifecycle to macOS LaunchAgent or Windows Task Scheduler.
- [`macos-service.ts`](../../src/flyto2/macos-service.ts) — health-checked LaunchAgent activation, rollback, and legacy Mac Kit migration status.
- [`windows-service.ts`](../../src/flyto2/windows-service.ts) — login-started scheduled task plus a fast PowerShell crash supervisor, health verification, and rollback.
- [`windows-task.ts`](../../src/flyto2/windows-task.ts) — Task Scheduler XML and task lifecycle primitives.
- [`windows-launcher.ts`](../../src/flyto2/windows-launcher.ts) — Windows Desktop launchers matching the macOS launcher surface.

## Native Cloudflare tunnel lifecycle
- [`native-tunnel.ts`](../../src/flyto2/native-tunnel.ts) — platform-neutral redundant tunnel lifecycle and readiness.
- [`migrateLegacyCloudflareTunnel`](../../src/flyto2/macos-tunnel.ts) — imports an existing Mac Kit fixed tunnel without exposing credentials.
- [`tunnel-import.ts`](../../src/flyto2/tunnel-import.ts) — imports a Cloudflare YAML/JSON config and assets into Runtime-owned storage on macOS or Windows.
- [`windows-tunnel.ts`](../../src/flyto2/windows-tunnel.ts) — two independent Windows cloudflared tasks with readiness checks and rollback.

## Build identity
- [`flyto2BuildInfo`](../../src/flyto2/build-info.ts) — resolves Runtime version, source Git SHA, and build timestamp for local/package verification. Public `/healthz` intentionally exposes only minimal liveness.

## Runtime manifest
- [`runtimeManifest`](../../src/flyto2/manifest.ts#L34)
- [`runtimeId`](../../src/flyto2/manifest.ts#L48)
- [`capability`](../../src/flyto2/manifest.ts#L63)

## Flyto2 execution protocol
- [`normalizeCloudJob`](../../src/flyto2/protocol.ts#L66)
- [`inferAssignmentKind`](../../src/flyto2/protocol.ts#L91)
- [`stringField`](../../src/flyto2/protocol.ts#L97)

## Reactive command runner
- [`ReactiveCommandRunner`](../../src/flyto2/reactive-command.ts#L71)
- [`reactiveEnvironment`](../../src/flyto2/reactive-command.ts#L393)
- [`normalizeEventType`](../../src/flyto2/reactive-command.ts#L417)
- [`evidenceRefForJob`](../../src/flyto2/reactive-command.ts#L423)
- [`jobIdFromEvidenceRef`](../../src/flyto2/reactive-command.ts#L427)
- [`evidenceMetadata`](../../src/flyto2/reactive-command.ts#L434)
- [`reactiveJobFromRow`](../../src/flyto2/reactive-command.ts#L448)

## Durable Runtime event stream
- [`RuntimeEventStore`](../../src/flyto2/runtime-events.ts#L63)
- [`normalizeEventInput`](../../src/flyto2/runtime-events.ts#L210)
- [`matchesNormalizedEvent`](../../src/flyto2/runtime-events.ts#L241)
- [`runtimeEventFromRow`](../../src/flyto2/runtime-events.ts#L256)
- [`normalizeSequence`](../../src/flyto2/runtime-events.ts#L271)
- [`normalizeLimit`](../../src/flyto2/runtime-events.ts#L279)
- [`normalizeWait`](../../src/flyto2/runtime-events.ts#L287)
- [`boundedToken`](../../src/flyto2/runtime-events.ts#L295)
- [`optionalToken`](../../src/flyto2/runtime-events.ts#L303)

## Flyto2-native MCP surface
- [`registerRuntimeTools`](../../src/flyto2/runtime-tools.ts#L26) — registers manifest, event, reactive execution, evidence, signal, and persistent filesystem-watch tools outside upstream server code.
- [`workspaceWatchOutputShape`](../../src/flyto2/runtime-tools.ts#L433)
- [`runtimeEventOutputShape`](../../src/flyto2/runtime-tools.ts#L447)

## MCP-to-event bridge
- [`emitDurableToolEvent`](../../src/flyto2/tool-events.ts#L6)
- [`structuredContent`](../../src/flyto2/tool-events.ts#L63)
- [`stringField`](../../src/flyto2/tool-events.ts#L70)
- [`numberField`](../../src/flyto2/tool-events.ts#L78)
- [`booleanField`](../../src/flyto2/tool-events.ts#L86)

## Persistent workspace filesystem watches
- [`WorkspaceWatchRegistry`](../../src/flyto2/workspace-watch.ts#L63) — persists native watches, canonicalizes targets, restores active watches after restart, batches external changes into shallow events, and fails closed on canonical-root drift.
- [`assertRootIdentity`](../../src/flyto2/workspace-watch.ts#L406)
- [`canonicalWatchTarget`](../../src/flyto2/workspace-watch.ts#L419)
- [`isPathInside`](../../src/flyto2/workspace-watch.ts#L433)
- [`normalizeDisplayPath`](../../src/flyto2/workspace-watch.ts#L439)
- [`normalizeDebounce`](../../src/flyto2/workspace-watch.ts#L444)
- [`normalizeEventType`](../../src/flyto2/workspace-watch.ts#L458)
- [`watchRecordFromRow`](../../src/flyto2/workspace-watch.ts#L466)
