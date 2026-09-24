import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluateCheckRuns,
  fetchCheckRuns,
  isSelfUpdateInProgress,
  readSelfUpdateStatus,
  runSelfUpdate,
  scheduleSelfUpdate,
  selfUpdatePaths,
  writeSelfUpdateStatus,
  type CheckRun,
  type SelfUpdateDeps,
} from "./self-update.js";

const green: CheckRun[] = [
  { name: "Smoke (ubuntu-latest)", status: "completed", conclusion: "success" },
  { name: "Smoke (macos-latest)", status: "completed", conclusion: "success" },
  { name: "Smoke (macos-15-intel)", status: "completed", conclusion: "success" },
  { name: "Smoke (windows-latest)", status: "completed", conclusion: "success" },
  { name: "Smoke (macos-latest-node24)", status: "completed", conclusion: "success" },
  { name: "Analyze", status: "completed", conclusion: "neutral" },
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t: test.TestContext) {
  const base = mkdtempSync(join(tmpdir(), "self-update-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const origin = join(base, "origin");
  mkdirSync(origin);
  git(origin, "init", "--quiet", "--initial-branch=main");
  git(origin, "config", "user.email", "t@example.com");
  git(origin, "config", "user.name", "t");
  const commit = (content: string) => {
    writeFileSync(join(origin, "README.md"), content);
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", content);
    return git(origin, "rev-parse", "HEAD");
  };
  const paths = selfUpdatePaths(join(base, "home"));
  return { base, origin, commit, paths };
}

function deps(origin: string, overrides: Partial<SelfUpdateDeps> & { current?: string | null; buildFails?: boolean } = {}) {
  const activated: string[] = [];
  const builds: string[] = [];
  const value: SelfUpdateDeps = {
    repository: origin,
    pnpm: ["fake-pnpm"],
    currentGitSha: () => overrides.current ?? null,
    fetchCheckRuns: async () => green,
    activate: (packageRoot) => { activated.push(packageRoot); },
    run: (command, args, options) => {
      if (command === "fake-pnpm") {
        if (args[0] === "build") {
          if (overrides.buildFails) return { status: 1, stdout: "", stderr: "vite: build exploded" };
          const sha = git(options!.cwd!, "rev-parse", "HEAD");
          mkdirSync(join(options!.cwd!, "dist"), { recursive: true });
          writeFileSync(join(options!.cwd!, "dist", "cli.js"), "");
          writeFileSync(join(options!.cwd!, "dist", "build-info.json"), JSON.stringify({ git_sha: sha }));
          builds.push(sha);
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    ...overrides,
  };
  return { value, activated, builds };
}

function scheduled(paths: ReturnType<typeof selfUpdatePaths>): string {
  return scheduleSelfUpdate(paths, () => {}).request_id;
}

test("only a commit with the complete cross-platform smoke matrix green may deploy", () => {
  assert.deepEqual(evaluateCheckRuns(green), { state: "passed" });
  assert.equal(evaluateCheckRuns([]).state, "missing");

  const missing = evaluateCheckRuns([
    { name: "Analyze (javascript-typescript)", status: "completed", conclusion: "success" },
    { name: "Analyze (actions)", status: "completed", conclusion: "success" },
  ]);
  assert.equal(missing.state, "missing");
  assert.match((missing as { detail: string }).detail, /required CI checks are missing/);

  assert.equal(
    evaluateCheckRuns(green.map((run) => run.name === "Smoke (macos-latest)"
      ? { ...run, status: "in_progress", conclusion: null }
      : run)).state,
    "pending",
  );

  const failed = evaluateCheckRuns(green.map((run) => run.name === "Smoke (windows-latest)"
    ? { ...run, conclusion: "failure" }
    : run));
  assert.equal(failed.state, "failed");
  assert.match((failed as { detail: string }).detail, /Smoke \(windows-latest\)=failure/);

  const skipped = evaluateCheckRuns(green.map((run) => run.name === "Smoke (macos-15-intel)"
    ? { ...run, conclusion: "skipped" }
    : run));
  assert.equal(skipped.state, "failed");
  assert.match((skipped as { detail: string }).detail, /Smoke \(macos-15-intel\)=skipped/);
});

test("GitHub check-run lookup requests an uncompressed JSON response", async () => {
  let request: { input?: string | URL | Request; init?: RequestInit };
  const fetchImpl: typeof fetch = async (input, init) => {
    request = { input, init };
    return new Response(JSON.stringify({ check_runs: green }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const runs = await fetchCheckRuns("a".repeat(40), fetchImpl);
  assert.deepEqual(runs, green);
  assert.equal(new Headers(request!.init?.headers).get("accept-encoding"), "identity");
});

test("scheduling refuses a second update while one is running, but not a dead or finished one", (t) => {
  const { paths } = fixture(t);
  const now = new Date("2026-09-23T10:00:00Z");
  const first = scheduleSelfUpdate(paths, () => {}, now);
  assert.equal(readSelfUpdateStatus(paths)?.phase, "scheduled");
  assert.throws(() => scheduleSelfUpdate(paths, () => {}, now), /already in progress/);
  assert.equal(isSelfUpdateInProgress(readSelfUpdateStatus(paths), new Date("2026-09-23T10:31:00Z")), false);
  writeSelfUpdateStatus(paths, { ...first, phase: "succeeded" });
  assert.notEqual(scheduleSelfUpdate(paths, () => {}, now).request_id, first.request_id);
});

test("a scheduler that cannot start the job leaves a failed status, not a stuck one", (t) => {
  const { paths } = fixture(t);
  assert.throws(() => scheduleSelfUpdate(paths, () => { throw new Error("launchctl said no"); }), /launchctl said no/);
  const status = readSelfUpdateStatus(paths);
  assert.equal(status?.phase, "failed");
  assert.match(status?.message ?? "", /Could not start the updater job: launchctl said no/);
});

test("an update builds main in its own directory and activates it", async (t) => {
  const { origin, commit, paths } = fixture(t);
  const target = commit("v2");
  const { value, activated, builds } = deps(origin, { current: "0".repeat(40) });
  const status = await runSelfUpdate(scheduled(paths), paths, value);
  assert.equal(status.phase, "succeeded", status.message);
  assert.equal(status.to_sha, target);
  assert.deepEqual(activated, [join(paths.buildsDir, target)]);
  assert.deepEqual(builds, [target]);
  assert.equal(readSelfUpdateStatus(paths)?.phase, "succeeded");
});

test("the running commit is reported up to date without building", async (t) => {
  const { origin, commit, paths } = fixture(t);
  const target = commit("v1");
  const { value, activated, builds } = deps(origin, { current: target });
  const status = await runSelfUpdate(scheduled(paths), paths, value);
  assert.equal(status.phase, "up_to_date");
  assert.deepEqual(activated, []);
  assert.deepEqual(builds, []);
});

test("a commit whose CI is not green is never built or activated", async (t) => {
  const { origin, commit, paths } = fixture(t);
  commit("v2");
  const { value, activated, builds } = deps(origin, {
    fetchCheckRuns: async () => green.map((run) => run.name === "Smoke (macos-latest)"
      ? { ...run, status: "in_progress", conclusion: null }
      : run),
  });
  const status = await runSelfUpdate(scheduled(paths), paths, value);
  assert.equal(status.phase, "failed");
  assert.match(status.message ?? "", /CI is still running.*Try again once CI is green/);
  assert.deepEqual(activated, []);
  assert.deepEqual(builds, []);
});

test("a failed build stops before touching the running service", async (t) => {
  const { origin, commit, paths } = fixture(t);
  commit("v2");
  const { value, activated } = deps(origin, { buildFails: true });
  const status = await runSelfUpdate(scheduled(paths), paths, value);
  assert.equal(status.phase, "failed");
  assert.match(status.message ?? "", /fake-pnpm build failed:\nvite: build exploded/);
  assert.deepEqual(activated, []);
});

test("a build that fails its health check is reported as rolled back", async (t) => {
  const { origin, commit, paths } = fixture(t);
  commit("v2");
  const { value } = deps(origin, {
    activate: () => {
      throw new Error("Flyto2 Runtime restart failed and the previous service was restored: /healthz timed out");
    },
  });
  const status = await runSelfUpdate(scheduled(paths), paths, value);
  assert.equal(status.phase, "rolled_back");
  assert.match(status.message ?? "", /previous Runtime is running again/);
});

test("successive updates keep only the new build and the one it replaced", async (t) => {
  const { origin, commit, paths } = fixture(t);
  const first = commit("v2");
  await runSelfUpdate(scheduled(paths), paths, deps(origin, { current: "0".repeat(40) }).value);
  const second = commit("v3");
  await runSelfUpdate(scheduled(paths), paths, deps(origin, { current: first }).value);
  const third = commit("v4");
  const status = await runSelfUpdate(scheduled(paths), paths, deps(origin, { current: second }).value);
  assert.equal(status.phase, "succeeded", status.message);
  assert.deepEqual(readdirSync(paths.buildsDir).sort(), [second, third].sort());
  assert.equal(existsSync(join(paths.buildsDir, first)), false);
});

test("a job only runs the request that was scheduled", async (t) => {
  const { origin, paths } = fixture(t);
  scheduled(paths);
  await assert.rejects(runSelfUpdate("upd_someone_else", paths, deps(origin).value), /not the scheduled request/);
});
