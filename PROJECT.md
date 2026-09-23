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
