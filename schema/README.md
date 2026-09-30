# Schemas

Versioned configuration and protocol schemas used by Flyto2 Runtime live here. Compatibility changes should remain explicit and migration-safe.

- `v1/devspace.schema.json` is the Runtime configuration schema.
- `flyto2.execution.v1/` is the cross-language Runtime/Core/Cloud capability protocol. Its JSON Schemas are generated from `src/flyto2/protocol.ts`; checked-in fixtures provide interoperability examples without coupling consumers to TypeScript.
