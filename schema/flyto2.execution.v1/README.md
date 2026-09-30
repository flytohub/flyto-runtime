# Flyto2 Execution Protocol v1

`flyto2.execution.v1` is the cross-language composition contract between
standalone Flyto2 Runtime and optional callers such as Flyto2 Core or Flyto2
Cloud.

The JSON Schemas in this directory are generated from Runtime's Zod protocol
schemas. Do not edit generated `*.schema.json` files by hand. After changing
`src/flyto2/protocol.ts`, run:

```bash
npm run schema:flyto2
```

The checked-in fixtures are deliberately small interoperability examples. They
contain no machine paths, credentials, command output, or product-specific
implementation details.

Important boundaries:

- Runtime works without Core or Cloud.
- Core/Cloud may consume the manifest/invocation/result/event wire contracts
  without importing Runtime implementation code.
- `status=accepted` is not terminal success. Follow the returned capability
  `operation.wait` / `operation.inspect` contract when present.
- Reuse the original `operation_id` when reconciling a side-effecting operation
  after an accepted result. Runtime's durable admission layer prevents a blind
  duplicate side effect.
