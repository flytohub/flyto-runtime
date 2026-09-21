import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import type { ServerConfig } from "../config.js";
import { DEVSPACE_VERSION } from "../version.js";
import {
  FLYTO2_EXECUTION_PROTOCOL_VERSION,
  flyto2RuntimeManifestSchema,
  type Flyto2Capability,
  type Flyto2RuntimeManifest,
} from "./protocol.js";

const RUNTIME_ID_FILE = "flyto2-runtime-id";

const BASE_CAPABILITIES: readonly Flyto2Capability[] = [
  capability("workspace.open", "low", "none", ["workspace"]),
  capability("source.read", "low", "none", ["file"]),
  capability("source.edit", "high", "policy", ["diff", "file"]),
  capability("process.run", "high", "policy", ["process", "log"]),
  capability("git.inspect", "low", "none", ["git"]),
  capability("git.mutate", "high", "policy", ["git", "diff"]),
  capability("test.run", "medium", "none", ["test", "log"]),
  capability("build.run", "medium", "none", ["build", "log"]),
  capability("review.diff", "low", "none", ["diff"]),
  capability("agent.delegate", "high", "policy", ["agent", "log"]),
];

export function runtimeManifest(config: ServerConfig): Flyto2RuntimeManifest {
  return flyto2RuntimeManifestSchema.parse({
    schema: FLYTO2_EXECUTION_PROTOCOL_VERSION,
    product: "Flyto2",
    runtime: "flyto-runtime",
    runtime_version: DEVSPACE_VERSION,
    runtime_id: runtimeId(config.stateDir),
    display_name: hostname() || "Flyto2 Runtime",
    platform: platform(),
    roles: ["executes_jobs"],
    capabilities: BASE_CAPABILITIES,
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

function capability(
  id: string,
  riskLevel: Flyto2Capability["risk_level"],
  approval: Flyto2Capability["approval"],
  evidence: string[],
): Flyto2Capability {
  return {
    id,
    revision: 1,
    risk_level: riskLevel,
    approval,
    evidence,
  };
}
