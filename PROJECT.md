# Flyto2 Runtime

Flyto2 Runtime is a standalone local execution runtime for coding and other machine-local capabilities.

## Owns

- MCP workspace and tool execution
- portable ChatGPT/Codex Plugin packaging from each user's configured public MCP URL
- local files, Git and process sessions
- isolated worktrees and review checkpoints
- local-agent delegation
- durable operation replay
- runtime capability self-description
- canonical capability catalog and provider execution seam
- shallow auditable capability lifecycle records
- first read-oriented capability adapters behind a Runtime-owned composition root
- optional Flyto2 Cloud bridge
- durable Runtime event stream and one-shot event waits
- reactive background commands with lazy local evidence
- persistent native filesystem watches for external editor/Git/build changes

## Model-facing boundary

Runtime internals are not the model API. In normal Codex mode the model-facing
surface is intentionally limited to workspace, read, patch, command/process,
and review primitives. Durable jobs, event streams, evidence, watches,
recovery, service lifecycle, and tunnel supervision remain Runtime-owned
implementation details unless an operator explicitly enables diagnostic
internals.

## Does not own

- Flyto2 Cloud tenancy, billing or hosted UI
- War Room planning/scheduling
- Cloud policy or organization membership
- robot-specific motion/vision implementation
- provider-specific business logic outside its adapters

## Composition

Standalone is the default product boundary. Flyto2 Cloud integration is optional and uses the versioned Flyto2 execution protocol plus existing paired-device job APIs.

Flyto2 Core may compose Runtime-provided machine/coding capabilities through the same versioned capability invocation/result contract. Core owns workflow composition/replay/evidence semantics; Runtime owns machine-local workspace, file, process, Git, agent, and service execution. Neither package imports the other's implementation internals.
