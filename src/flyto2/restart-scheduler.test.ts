import assert from "node:assert/strict";
import test from "node:test";
import {
  currentRestartJobSpec,
  restartWorkerArguments,
} from "./restart-scheduler.js";

test("restart worker arguments preserve config directories with spaces", () => {
  assert.deepEqual(
    restartWorkerArguments("/Users/chester/DevSpace 連線/系統"),
    ["service", "restart-worker", "/Users/chester/DevSpace 連線/系統"],
  );
});

test("current restart job spec uses the active Runtime build and node", () => {
  const spec = currentRestartJobSpec("/tmp/flyto2 config");
  assert.equal(spec.nodePath, process.execPath);
  assert.match(spec.cliPath, /dist[\\/]cli\.js$/);
  assert.equal(spec.configDirectory, "/tmp/flyto2 config");
  assert.ok(spec.pathEnvironment.includes(process.execPath.split(/[\\/]/).slice(0, -1).join(process.platform === "win32" ? "\\" : "/")));
});
