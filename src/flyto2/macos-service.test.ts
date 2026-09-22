import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL,
  installMacRuntimeService,
  macRuntimeServicePaths,
  macRuntimeServiceStatus,
  renderMacRuntimeLaunchAgent,
  restartLaunchAgentWithRecovery,
} from "./macos-service.js";

test("native LaunchAgent plist points directly at Flyto2 Runtime", () => {
  const homeDirectory = "/Users/example";
  const plist = renderMacRuntimeLaunchAgent({
    packageRoot: "/opt/flyto2/runtime",
    configDirectory: "/Users/example/.flyto2/runtime",
    nodePath: "/opt/node/bin/node",
    pathEnvironment: "/opt/node/bin:/usr/bin:/bin",
    homeDirectory,
  });

  assert.match(plist, new RegExp(FLYTO2_RUNTIME_LAUNCH_AGENT_LABEL.replaceAll(".", "\\.")));
  assert.match(plist, /\/opt\/flyto2\/runtime\/dist\/cli\.js/);
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /FLYTO2_RUNTIME_CONFIG_DIR/);
  assert.match(plist, /\/Users\/example\/\.flyto2\/runtime/);
  assert.doesNotMatch(plist, /service\.mjs/);
  assert.doesNotMatch(plist, /local\.devspace\.mac-kit/);
  assert.match(plist, /Library\/Logs\/Flyto2 Runtime\/runtime\.log/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>1<\/integer>/);
});

test("native service installer can stage a LaunchAgent without loading it", {
  skip: platform() !== "darwin",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const packageRoot = join(root, "runtime");
  const homeDirectory = join(root, "home");
  const configDirectory = join(root, "config");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "dist", "cli.js"), "console.log('runtime');\n");

  const loadedBeforeStage = macRuntimeServiceStatus({ homeDirectory }).loaded;
  const status = installMacRuntimeService({
    packageRoot,
    configDirectory,
    homeDirectory,
    nodePath: process.execPath,
    start: false,
  });
  const paths = macRuntimeServicePaths(homeDirectory);

  assert.equal(status.installed, true);
  assert.equal(status.loaded, loadedBeforeStage);
  assert.equal(status.plistPath, paths.plistPath);
  const plist = await readFile(paths.plistPath, "utf8");
  assert.match(plist, /local\.flyto2\.runtime/);
  assert.match(plist, /FLYTO2_RUNTIME_CONFIG_DIR/);
});

test("restart waits for unload and retries a transient bootstrap race within one second", () => {
  let loaded = true;
  let healthy = false;
  let activationAttempts = 0;
  let elapsed = 0;
  const events: string[] = [];

  restartLaunchAgentWithRecovery({
    bootout: () => {
      events.push("bootout");
      loaded = false;
    },
    isLoaded: () => loaded,
    activate: () => {
      activationAttempts += 1;
      events.push(`activate:${activationAttempts}`);
      if (activationAttempts < 3) throw new Error("Bootstrap failed: 5");
      loaded = true;
      healthy = true;
    },
    isHealthy: () => healthy,
    rollback: () => events.push("rollback"),
    sleep: (milliseconds) => {
      elapsed += milliseconds;
    },
  }, {
    activationAttempts: 5,
    activationRetryDelayMs: 250,
  });

  assert.deepEqual(events, ["bootout", "activate:1", "activate:2", "activate:3"]);
  assert.equal(elapsed, 500);
  assert.ok(elapsed <= 1_000);
});

test("failed restart restores the previous LaunchAgent and verifies its health", () => {
  let loaded = true;
  let rollback = false;
  let currentActivationAttempts = 0;
  const events: string[] = [];

  assert.throws(
    () => restartLaunchAgentWithRecovery({
      bootout: () => {
        events.push("bootout");
        loaded = false;
      },
      isLoaded: () => loaded,
      activate: () => {
        if (!rollback) {
          currentActivationAttempts += 1;
          throw new Error("Bootstrap failed: 5");
        }
        events.push("activate:previous");
        loaded = true;
      },
      isHealthy: () => rollback && loaded,
      rollback: () => {
        events.push("rollback");
        rollback = true;
      },
      sleep: () => undefined,
    }, {
      activationAttempts: 3,
      activationRetryDelayMs: 0,
      healthTimeoutMs: 0,
    }),
    /previous service was restored: Bootstrap failed: 5/,
  );

  assert.equal(currentActivationAttempts, 3);
  assert.deepEqual(events, ["bootout", "bootout", "rollback", "activate:previous"]);
  assert.equal(loaded, true);
});

test("restart reports both failures when rollback cannot restore service", () => {
  assert.throws(
    () => restartLaunchAgentWithRecovery({
      bootout: () => undefined,
      isLoaded: () => false,
      activate: () => {
        throw new Error("activation failed");
      },
      isHealthy: () => false,
      rollback: () => {
        throw new Error("rollback failed");
      },
      sleep: () => undefined,
    }, { activationAttempts: 1 }),
    (error: unknown) => error instanceof AggregateError
      && error.message.includes("restart and automatic rollback both failed")
      && error.errors.length === 2,
  );
});
