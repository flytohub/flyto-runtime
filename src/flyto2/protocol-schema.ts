import * as z from "zod/v4";
import {
  flyto2AssignmentSchema,
  flyto2CapabilityInvocationSchema,
  flyto2CapabilityResultSchema,
  flyto2CapabilitySchema,
  flyto2RuntimeEventSchema,
  flyto2RuntimeManifestSchema,
} from "./protocol.js";

export const FLYTO2_EXECUTION_SCHEMA_BASE_URL =
  "https://raw.githubusercontent.com/flytohub/flyto-runtime/main/schema/flyto2.execution.v1";

export const FLYTO2_EXECUTION_SCHEMA_NAMES = [
  "capability",
  "runtime-manifest",
  "capability-invocation",
  "capability-result",
  "assignment",
  "runtime-event",
] as const;

export type Flyto2ExecutionSchemaName =
  typeof FLYTO2_EXECUTION_SCHEMA_NAMES[number];

interface ProtocolSchemaDefinition {
  title: string;
  description: string;
  schema: z.ZodType;
  io: "input" | "output";
}

const PROTOCOL_SCHEMAS: Record<Flyto2ExecutionSchemaName, ProtocolSchemaDefinition> = {
  capability: {
    title: "Flyto2 Runtime capability descriptor",
    description: "A versioned capability advertised by a composed Flyto2 Runtime instance.",
    schema: flyto2CapabilitySchema,
    io: "output",
  },
  "runtime-manifest": {
    title: "Flyto2 Runtime manifest",
    description: "The live capabilities actually exposed by one Flyto2 Runtime instance.",
    schema: flyto2RuntimeManifestSchema,
    io: "output",
  },
  "capability-invocation": {
    title: "Flyto2 capability invocation",
    description: "Provider-neutral request envelope for invoking one Runtime capability.",
    schema: flyto2CapabilityInvocationSchema,
    io: "input",
  },
  "capability-result": {
    title: "Flyto2 capability result",
    description: "Provider-neutral accepted, successful, or failed capability result envelope.",
    schema: flyto2CapabilityResultSchema,
    io: "output",
  },
  assignment: {
    title: "Flyto2 Runtime assignment",
    description: "Optional Flyto2 Cloud assignment envelope delivered to Runtime.",
    schema: flyto2AssignmentSchema,
    io: "input",
  },
  "runtime-event": {
    title: "Flyto2 Runtime event",
    description: "Shallow provider-neutral Runtime event with optional evidence references.",
    schema: flyto2RuntimeEventSchema,
    io: "output",
  },
};

export function flyto2ExecutionJsonSchema(
  name: Flyto2ExecutionSchemaName,
): object {
  const definition = PROTOCOL_SCHEMAS[name];
  return {
    $id: `${FLYTO2_EXECUTION_SCHEMA_BASE_URL}/${name}.schema.json`,
    title: definition.title,
    description: definition.description,
    ...z.toJSONSchema(definition.schema, {
      target: "draft-2020-12",
      io: definition.io,
    }),
  };
}

export function flyto2ExecutionJsonSchemas(): Record<Flyto2ExecutionSchemaName, object> {
  return Object.fromEntries(
    FLYTO2_EXECUTION_SCHEMA_NAMES.map((name) => [
      name,
      flyto2ExecutionJsonSchema(name),
    ]),
  ) as Record<Flyto2ExecutionSchemaName, object>;
}
