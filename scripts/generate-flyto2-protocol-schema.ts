import { mkdirSync, writeFileSync } from "node:fs";
import {
  FLYTO2_EXECUTION_SCHEMA_NAMES,
  flyto2ExecutionJsonSchema,
} from "../src/flyto2/protocol-schema.js";

const outputDir = new URL("../schema/flyto2.execution.v1/", import.meta.url);
mkdirSync(outputDir, { recursive: true });

for (const name of FLYTO2_EXECUTION_SCHEMA_NAMES) {
  const outputPath = new URL(`${name}.schema.json`, outputDir);
  writeFileSync(
    outputPath,
    `${JSON.stringify(flyto2ExecutionJsonSchema(name), null, 2)}\n`,
  );
}
