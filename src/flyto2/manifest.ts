import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import type { ServerConfig } from "../config.js";
import { DEVSPACE_VERSION } from "../version.js";
import { runtimeCapabilityCatalog } from "./capability-catalog.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  flyto2RuntimeManifestSchema,
  type Flyto2Capability,
  type Flyto2RuntimeManifest,
} from "./protocol.js";

const RUNTIME_ID_FILE = "flyto2-runtime-id";

export function runtimeManifest(
  config: ServerConfig,
  capabilities: readonly Flyto2Capability[] = runtimeCapabilityCatalog(),
): Flyto2RuntimeManifest {
  return flyto2RuntimeManifestSchema.parse({
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    product: "Flyto2",
    runtime: "flyto-runtime",
    runtime_version: DEVSPACE_VERSION,
    runtime_id: runtimeId(config.stateDir),
    display_name: hostname() || "Flyto2 Runtime",
    platform: platform(),
    roles: ["executes_jobs"],
    capabilities,
  });
}

export function runtimeId(stateDir: string): string {
  const file = join(stateDir, RUNTIME_ID_FILE);
  if (existsSync(file)) {
    const value = readFileSync(file, "utf8").trim();
    if (/^rt_[0-9a-f]{32}$/.test(value)) return value;
    throw new Error(`Invalid Flyto2 Runtime identity file: ${file}`);
  }

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const value = `rt_${randomUUID().replaceAll("-", "")}`;
  writeFileSync(file, value + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return value;
}
