import assert from "node:assert/strict";
import test from "node:test";
import { renderMacOneShotAgent } from "./macos-service.js";
import { renderWindowsSelfUpdateScript, selfUpdateRunArguments } from "./self-update-scheduler.js";

test("the macOS updater runs once under launchd and is never kept alive", () => {
  const plist = renderMacOneShotAgent({
    label: "local.flyto2.runtime.updater",
    programArguments: ["/opt/node", "/pkg/runtime-entry.js", ...selfUpdateRunArguments("upd_1")],
    environment: { FLYTO2_RUNTIME_CONFIG_DIR: "/Users/a & b/.devspace" },
    logPath: "/tmp/self-update.log",
  });
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n  <false\/>/);
  assert.match(plist, /<string>self-update<\/string>\n    <string>run<\/string>\n    <string>upd_1<\/string>/);
  assert.match(plist, /\/Users\/a &amp; b\/\.devspace/);
});

test("the Windows updater script sets the Runtime environment and quotes paths", () => {
  const script = renderWindowsSelfUpdateScript({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\o'brien\\flyto\\dist\\cli.js",
    configDirectory: "C:\\Users\\o'brien\\.devspace",
    pathEnvironment: "C:\\Program Files\\nodejs;C:\\Windows",
  }, "upd_2");
  assert.match(script, /\$env:FLYTO2_RUNTIME_CONFIG_DIR = 'C:\\Users\\o''brien\\\.devspace'/);
  assert.match(script, /& 'C:\\Program Files\\nodejs\\node\.exe' 'C:\\Users\\o''brien\\flyto\\dist\\cli\.js' 'service' 'self-update' 'run' 'upd_2'/);
  assert.match(script, /exit \$LASTEXITCODE/);
});
