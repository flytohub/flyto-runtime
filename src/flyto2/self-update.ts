import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Self-update lets a remote host (ChatGPT, Codex, a phone) move this machine's
// Runtime to the newest CI-green commit on main without anyone at the keyboard.
//
// The Runtime cannot restart itself: launchd / Task Scheduler stops the whole
// service job, including any child it spawned. So the request only records a
// status file and hands the work to a separate one-shot job owned by the OS
// service manager. That job fetches, builds in its own directory (never the
// user's checkout), switches the service with the existing health-checked
// restart, and lets that restart roll back to the previous build on failure.
// OAuth grants live in the state database and the tunnel is a separate
// process, so the host reconnects to the same URL after a few seconds.

export const SELF_UPDATE_REPOSITORY = "https://github.com/flytohub/flyto-runtime.git";
export const SELF_UPDATE_BRANCH = "main";
const CHECK_RUNS_API = "https://api.github.com/repos/flytohub/flyto-runtime/commits";
// A job that stops reporting for this long is treated as dead, so a crashed
// updater cannot block every later request.
const STALE_AFTER_MS = 30 * 60 * 1000;

export type SelfUpdatePhase =
  | "scheduled"
  | "fetching"
  | "checking_ci"
  | "building"
  | "activating"
  | "succeeded"
  | "up_to_date"
  | "rolled_back"
  | "failed";

const TERMINAL_PHASES: ReadonlySet<SelfUpdatePhase> = new Set([
  "succeeded",
  "up_to_date",
  "rolled_back",
  "failed",
]);

export interface SelfUpdateStatus {
  request_id: string;
  phase: SelfUpdatePhase;
  from_sha?: string | null;
  to_sha?: string;
  package_root?: string;
  message?: string;
  started_at: string;
  updated_at: string;
}

export interface SelfUpdatePaths {
  root: string;
  statusPath: string;
  sourceDir: string;
  buildsDir: string;
  logPath: string;
}

export function selfUpdatePaths(runtimeHome: string): SelfUpdatePaths {
  const root = join(runtimeHome, "self-update");
  return {
    root,
    statusPath: join(root, "status.json"),
    sourceDir: join(root, "source"),
    buildsDir: join(root, "builds"),
    logPath: join(root, "self-update.log"),
  };
}

export function readSelfUpdateStatus(paths: SelfUpdatePaths): SelfUpdateStatus | undefined {
  try {
    return JSON.parse(readFileSync(paths.statusPath, "utf8")) as SelfUpdateStatus;
  } catch {
    return undefined;
  }
}

export function writeSelfUpdateStatus(paths: SelfUpdatePaths, status: SelfUpdateStatus): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const temporary = `${paths.statusPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.statusPath);
}

export function isSelfUpdateInProgress(status: SelfUpdateStatus | undefined, now: Date): boolean {
  if (!status || TERMINAL_PHASES.has(status.phase)) return false;
  return now.getTime() - Date.parse(status.updated_at) < STALE_AFTER_MS;
}

export interface SelfUpdateScheduler {
  // Starts `service self-update run <requestId>` as a job the OS service
  // manager owns, so it outlives the Runtime restart it triggers.
  (requestId: string): void;
}

export function scheduleSelfUpdate(
  paths: SelfUpdatePaths,
  schedule: SelfUpdateScheduler,
  now = new Date(),
): SelfUpdateStatus {
  const current = readSelfUpdateStatus(paths);
  if (isSelfUpdateInProgress(current, now)) {
    throw new Error(
      `A Runtime update is already in progress (${current!.request_id}, ${current!.phase}). Check its status instead of starting another.`,
    );
  }
  const timestamp = now.toISOString();
  const status: SelfUpdateStatus = {
    request_id: `upd_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    phase: "scheduled",
    started_at: timestamp,
    updated_at: timestamp,
  };
  writeSelfUpdateStatus(paths, status);
  try {
    schedule(status.request_id);
  } catch (error) {
    const failed = { ...status, phase: "failed" as const, message: `Could not start the updater job: ${errorMessage(error)}` };
    writeSelfUpdateStatus(paths, failed);
    throw error;
  }
  return status;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export type CiVerdict = { state: "passed" } | { state: "pending" | "failed" | "missing"; detail: string };

const REQUIRED_SELF_UPDATE_CHECKS = [
  "Smoke (ubuntu-latest)",
  "Smoke (macos-latest)",
  "Smoke (macos-15-intel)",
  "Smoke (windows-latest)",
] as const;

// Only a commit whose complete cross-platform smoke matrix exists and finished
// green may be deployed. Other reported checks must also be non-failing.
export function evaluateCheckRuns(runs: CheckRun[]): CiVerdict {
  if (runs.length === 0) return { state: "missing", detail: "no CI results exist for this commit yet" };

  const missing = REQUIRED_SELF_UPDATE_CHECKS.filter(
    (required) => !runs.some((run) => run.name === required),
  );
  if (missing.length > 0) {
    return { state: "missing", detail: `required CI checks are missing: ${missing.join(", ")}` };
  }

  const pending = runs.filter((run) => run.status !== "completed");
  if (pending.length > 0) {
    return { state: "pending", detail: `CI is still running: ${pending.map((run) => run.name).join(", ")}` };
  }

  const requiredNotSuccessful = runs.filter(
    (run) => REQUIRED_SELF_UPDATE_CHECKS.includes(run.name as typeof REQUIRED_SELF_UPDATE_CHECKS[number])
      && run.conclusion !== "success",
  );
  if (requiredNotSuccessful.length > 0) {
    return {
      state: "failed",
      detail: `required CI did not pass: ${requiredNotSuccessful.map((run) => `${run.name}=${run.conclusion}`).join(", ")}`,
    };
  }

  const failed = runs.filter((run) => !["success", "neutral", "skipped"].includes(run.conclusion ?? ""));
  if (failed.length > 0) {
    return { state: "failed", detail: `CI did not pass: ${failed.map((run) => `${run.name}=${run.conclusion}`).join(", ")}` };
  }
  return { state: "passed" };
}

export async function fetchCheckRuns(sha: string, fetchImpl: typeof fetch = fetch): Promise<CheckRun[]> {
  const response = await fetchImpl(`${CHECK_RUNS_API}/${sha}/check-runs?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Flyto2-Runtime",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub check-run lookup failed (${response.status} ${response.statusText}).`);
  const body = await response.json() as { check_runs?: Array<Record<string, unknown>> };
  return (body.check_runs ?? []).map((run) => ({
    name: String(run.name ?? "unknown"),
    status: String(run.status ?? "unknown"),
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
  }));
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface SelfUpdateDeps {
  run: (command: string, args: string[], options?: { cwd?: string }) => CommandResult;
  fetchCheckRuns: (sha: string) => Promise<CheckRun[]>;
  currentGitSha: () => string | null;
  // Points the background service at packageRoot and restarts it behind the
  // /healthz gate; throws after restoring the previous service on failure.
  activate: (packageRoot: string) => void;
  pnpmCommand?: string;
  now?: () => Date;
  // Tests only. The CLI never sets this: a remote caller must not be able to
  // point the updater at code other than the published repository.
  repository?: string;
}

export async function runSelfUpdate(
  requestId: string,
  paths: SelfUpdatePaths,
  deps: SelfUpdateDeps,
): Promise<SelfUpdateStatus> {
  const now = deps.now ?? (() => new Date());
  const existing = readSelfUpdateStatus(paths);
  if (existing?.request_id !== requestId) {
    throw new Error(`Update request ${requestId} is not the scheduled request.`);
  }
  let status: SelfUpdateStatus = { ...existing, from_sha: deps.currentGitSha() };
  const advance = (phase: SelfUpdatePhase, fields: Partial<SelfUpdateStatus> = {}): SelfUpdateStatus => {
    status = { ...status, ...fields, phase, updated_at: now().toISOString() };
    writeSelfUpdateStatus(paths, status);
    return status;
  };

  try {
    advance("fetching");
    const target = fetchMain(paths, deps);
    advance("checking_ci", { to_sha: target });
    if (target === status.from_sha) {
      return advance("up_to_date", { message: `Already running ${short(target)}, the newest commit on ${SELF_UPDATE_BRANCH}.` });
    }
    const verdict = evaluateCheckRuns(await deps.fetchCheckRuns(target));
    if (verdict.state !== "passed") {
      return advance("failed", { message: `Not updating to ${short(target)}: ${verdict.detail}. Try again once CI is green.` });
    }

    advance("building");
    const packageRoot = buildCommit(paths, deps, target);
    advance("activating", { package_root: packageRoot });
    try {
      deps.activate(packageRoot);
    } catch (error) {
      const restored = /previous service was restored/i.test(errorMessage(error));
      return advance(restored ? "rolled_back" : "failed", {
        message: restored
          ? `Built ${short(target)} but it failed its health check; the previous Runtime is running again. ${errorMessage(error)}`
          : `Activation failed: ${errorMessage(error)}`,
      });
    }
    pruneBuilds(paths, deps, [target, status.from_sha ?? ""]);
    return advance("succeeded", { message: `Runtime now runs ${short(target)}.` });
  } catch (error) {
    return advance("failed", { message: errorMessage(error) });
  }
}

function fetchMain(paths: SelfUpdatePaths, deps: SelfUpdateDeps): string {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  if (!existsSync(join(paths.sourceDir, ".git"))) {
    rmSync(paths.sourceDir, { recursive: true, force: true });
    must(deps, "git", ["clone", "--filter=blob:none", "--no-checkout", deps.repository ?? SELF_UPDATE_REPOSITORY, paths.sourceDir]);
  }
  must(deps, "git", ["-C", paths.sourceDir, "fetch", "--prune", "origin", SELF_UPDATE_BRANCH]);
  const sha = must(deps, "git", ["-C", paths.sourceDir, "rev-parse", `origin/${SELF_UPDATE_BRANCH}`]).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Unexpected commit id from git: ${sha}`);
  return sha;
}

function buildCommit(paths: SelfUpdatePaths, deps: SelfUpdateDeps, sha: string): string {
  const buildDir = join(paths.buildsDir, sha);
  if (builtSha(buildDir) === sha) return buildDir;

  mkdirSync(paths.buildsDir, { recursive: true, mode: 0o700 });
  rmSync(buildDir, { recursive: true, force: true });
  must(deps, "git", ["-C", paths.sourceDir, "worktree", "prune"]);
  must(deps, "git", ["-C", paths.sourceDir, "worktree", "add", "--detach", "--force", buildDir, sha]);
  const pnpm = deps.pnpmCommand ?? "pnpm";
  must(deps, pnpm, ["install", "--frozen-lockfile"], { cwd: buildDir });
  must(deps, pnpm, ["build"], { cwd: buildDir });
  if (builtSha(buildDir) !== sha) {
    throw new Error(`The build in ${buildDir} does not report commit ${short(sha)}.`);
  }
  return buildDir;
}

function builtSha(buildDir: string): string | undefined {
  if (!existsSync(join(buildDir, "dist", "cli.js"))) return undefined;
  try {
    const info = JSON.parse(readFileSync(join(buildDir, "dist", "build-info.json"), "utf8")) as { git_sha?: unknown };
    return typeof info.git_sha === "string" ? info.git_sha : undefined;
  } catch {
    return undefined;
  }
}

// Keeps the new build and the one it replaced, so a manual rollback still has
// something to return to; everything older is removed.
function pruneBuilds(paths: SelfUpdatePaths, deps: SelfUpdateDeps, keep: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(paths.buildsDir);
  } catch {
    return;
  }
  for (const entry of entries.filter((name) => !keep.includes(name))) {
    deps.run("git", ["-C", paths.sourceDir, "worktree", "remove", "--force", join(paths.buildsDir, entry)]);
    rmSync(join(paths.buildsDir, entry), { recursive: true, force: true });
  }
}

function must(deps: SelfUpdateDeps, command: string, args: string[], options?: { cwd?: string }): string {
  const result = deps.run(command, args, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n");
    throw new Error(`${command} ${args[0] === "-C" ? args[2] : args[0]} failed${detail ? `:\n${detail}` : "."}`);
  }
  return result.stdout;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
