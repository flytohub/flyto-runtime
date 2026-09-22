import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEVSPACE_VERSION } from "../version.js";

export interface Flyto2BuildInfo {
  version: string;
  git_sha: string | null;
  built_at: string | null;
  git_dirty: boolean | null;
  source: "build" | "environment" | "runtime";
}

interface PersistedBuildInfo {
  version?: unknown;
  git_sha?: unknown;
  built_at?: unknown;
  git_dirty?: unknown;
}

export function flyto2BuildInfo(
  env: NodeJS.ProcessEnv = process.env,
): Flyto2BuildInfo {
  const environmentSha = normalizeGitSha(env.FLYTO2_BUILD_GIT_SHA);
  const environmentBuiltAt = normalizeTimestamp(env.FLYTO2_BUILD_TIMESTAMP);
  if (environmentSha || environmentBuiltAt) {
    return {
      version: DEVSPACE_VERSION,
      git_sha: environmentSha,
      built_at: environmentBuiltAt,
      git_dirty: normalizeBoolean(env.FLYTO2_BUILD_GIT_DIRTY),
      source: "environment",
    };
  }

  const file = fileURLToPath(new URL("../../dist/build-info.json", import.meta.url));
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as PersistedBuildInfo;
      return {
        version:
          typeof parsed.version === "string" && parsed.version
            ? parsed.version
            : DEVSPACE_VERSION,
        git_sha: normalizeGitSha(parsed.git_sha),
        built_at: normalizeTimestamp(parsed.built_at),
        git_dirty: normalizeBoolean(parsed.git_dirty),
        source: "build",
      };
    } catch {
      // A malformed optional build receipt must not prevent Runtime startup.
    }
  }

  return {
    version: DEVSPACE_VERSION,
    git_sha: null,
    built_at: null,
    git_dirty: null,
    source: "runtime",
  };
}

function normalizeGitSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  return Number.isNaN(Date.parse(normalized)) ? null : normalized;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return null;
}
