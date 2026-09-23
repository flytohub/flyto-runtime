import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, posix } from "node:path";
import test from "node:test";
import { selfUpdatePaths } from "./self-update.js";
import {
  SELF_UPDATE_LAUNCH_AGENT_LABEL,
  SELF_UPDATE_WINDOWS_TASK,
  nativeSelfUpdateScheduler,
} from "./self-update-scheduler.js";

// These drive the real launchd / Task Scheduler, so they only run where CI
// opts in; a developer's `pnpm test` must never touch their installed service.
const enabled = process.env.FLYTO2_NATIVE_SERVICE_TESTS === "1"
  && (platform() === "darwin" || platform() === "win32");

async function waitFor<T>(read: () => T | undefined, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the native job.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test("the updater job runs under the OS service manager with the Runtime environment", { skip: !enabled }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "native-job-"));
  const output = join(dir, "out.json");
  // A space in the script path and a quote in the config path exercise the
  // plist escaping and the PowerShell literal quoting for real.
  const fakeCli = join(dir, "fake cli.mjs");
  const configDirectory = join(dir, "cfg o'brien");
  mkdirSync(configDirectory);
  writeFileSync(fakeCli, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(output)}, JSON.stringify({ argv: process.argv.slice(2), config: process.env.FLYTO2_RUNTIME_CONFIG_DIR }));`,
  ].join("\n"));
  t.after(async () => {
    if (platform() === "darwin") {
      const { stopMacAgent } = await import("./macos-service.js");
      stopMacAgent(SELF_UPDATE_LAUNCH_AGENT_LABEL, posix.join(homedir(), "Library", "LaunchAgents", `${SELF_UPDATE_LAUNCH_AGENT_LABEL}.plist`));
    } else {
      const { stopWindowsTask } = await import("./windows-service.js");
      stopWindowsTask(SELF_UPDATE_WINDOWS_TASK);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const schedule = await nativeSelfUpdateScheduler(selfUpdatePaths(dir), {
    nodePath: process.execPath,
    cliPath: fakeCli,
    configDirectory,
    pathEnvironment: process.env.PATH ?? "",
  });
  schedule("upd_native_test");

  const result = await waitFor(() => existsSync(output)
    ? JSON.parse(readFileSync(output, "utf8")) as { argv: string[]; config: string }
    : undefined);
  assert.deepEqual(result.argv, ["service", "self-update", "run", "upd_native_test"]);
  assert.equal(result.config, configDirectory);
});

test("a kept-alive macOS agent is restarted by launchd and fully removed on stop", { skip: !enabled || platform() !== "darwin" }, async (t) => {
  const { isMacAgentLoaded, startMacOneShotAgent, stopMacAgent } = await import("./macos-service.js");
  const dir = mkdtempSync(join(tmpdir(), "native-keepalive-"));
  const runs = join(dir, "runs.txt");
  const label = "local.flyto2.runtime.test-keepalive";
  const plistPath = posix.join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  t.after(() => {
    stopMacAgent(label, plistPath);
    rmSync(dir, { recursive: true, force: true });
  });

  startMacOneShotAgent({
    label,
    plistPath,
    programArguments: ["/bin/sh", "-c", `echo run >> '${runs}'`],
    environment: {},
    logPath: join(dir, "agent.log"),
    keepAlive: true,
  });
  await waitFor(() => existsSync(runs) && readFileSync(runs, "utf8").trim().split("\n").length >= 2 ? true : undefined);

  stopMacAgent(label, plistPath);
  assert.equal(isMacAgentLoaded(label), false);
  assert.equal(existsSync(plistPath), false);
});

test("uninstalling the macOS service leaves no plist copies behind", { skip: !enabled || platform() !== "darwin" }, async (t) => {
  const { macRuntimeServicePaths, uninstallMacRuntimeService } = await import("./macos-service.js");
  const home = mkdtempSync(join(tmpdir(), "native-uninstall-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = macRuntimeServicePaths(home);
  mkdirSync(posix.dirname(paths.plistPath), { recursive: true });
  for (const path of [paths.plistPath, paths.activePlistPath, paths.previousPlistPath]) writeFileSync(path, "<plist/>");

  uninstallMacRuntimeService({ homeDirectory: home });
  for (const path of [paths.plistPath, paths.activePlistPath, paths.previousPlistPath]) {
    assert.equal(existsSync(path), false, path);
  }
});
