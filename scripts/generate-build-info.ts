import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await import("node:fs/promises").then(({ readFile }) =>
    readFile(resolve(root, "package.json"), "utf8"),
  ),
) as { version?: string };

let gitSha: string | null = null;
let gitDirty: boolean | null = null;
try {
  gitSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  gitDirty = execFileSync("git", ["-C", root, "status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim().length > 0;
} catch {
  gitSha = process.env.FLYTO2_BUILD_GIT_SHA?.trim() || null;
}

const receipt = {
  product: "Flyto2",
  runtime: "flyto-runtime",
  version: packageJson.version ?? "unknown",
  git_sha: gitSha,
  git_dirty: gitDirty,
  built_at: new Date().toISOString(),
};

const destination = resolve(root, "dist", "build-info.json");
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(receipt, null, 2) + "\n", "utf8");
console.log(`Wrote ${destination}`);
