import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };

if (typeof packageJson.version !== "string" || !packageJson.version) {
  throw new Error("Flyto2 Runtime package version is missing.");
}

export const FLYTO2_RUNTIME_VERSION = packageJson.version;
// Compatibility alias for upstream modules while the fork remains merge-friendly.
export const DEVSPACE_VERSION = FLYTO2_RUNTIME_VERSION;
