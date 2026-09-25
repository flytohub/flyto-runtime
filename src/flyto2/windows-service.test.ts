import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWindowsRuntimeConfigDirectory,
  renderWindowsRuntimeScript,
  renderWindowsRuntimeTask,
  windowsRuntimeServicePaths,
  windowsRuntimeServiceRoot,
} from "./windows-service.js";

test("Windows Runtime wrapper preserves config and paths with spaces", () => {
  const script = renderWindowsRuntimeScript({
    packageRoot: "C:\\Users\\Chester Hsu\\AppData\\Local\\Flyto2 Runtime\\releases\\v1",
    configDirectory: "C:\\Users\\Chester Hsu\\Flyto2 Config",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
  });

  assert.match(script, /FLYTO2_RUNTIME_CONFIG_DIR/);
  assert.match(script, /FLYTO2_RUNTIME_MANAGED_SERVICE/);
  assert.match(script, /DEVSPACE_CONFIG_DIR/);
  assert.match(script, /Flyto2 Config/);
  assert.match(script, /Set-Location -LiteralPath/);
  assert.match(script, /dist\\cli\.js/);
  assert.match(script, /'serve'/);
  assert.match(script, /while \(\$true\)/);
  assert.match(script, /Start-Sleep -Seconds \$restartDelaySeconds/);
  assert.match(script, /\[Math\]::Min\(30, \$restartDelaySeconds \* 2\)/);
});

test("installed config is recovered from the Runtime wrapper", () => {
  const configDirectory = "C:\\Users\\O'Brien\\Flyto2 Config";
  const script = renderWindowsRuntimeScript({
    packageRoot: "C:\\Flyto2 Runtime",
    configDirectory,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
  });
  assert.equal(parseWindowsRuntimeConfigDirectory(script), configDirectory);
});

test("Windows Runtime task launches the wrapper and restarts on failure", () => {
  const xml = renderWindowsRuntimeTask({
    scriptPath: "C:\\Users\\chester\\AppData\\Local\\Flyto2 Runtime\\service\\run-runtime.ps1",
    packageRoot: "C:\\Users\\chester\\AppData\\Local\\Flyto2 Runtime\\releases\\v1",
    principal: "PC\\chester",
  });

  assert.match(xml, /powershell\.exe/);
  assert.match(xml, /ExecutionPolicy Bypass/);
  assert.match(xml, /run-runtime\.ps1/);
  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, /<Interval>PT1M<\/Interval>/);
  assert.match(xml, /<Count>255<\/Count>/);
});

test("Windows Runtime storage follows LOCALAPPDATA", () => {
  const root = windowsRuntimeServiceRoot(
    { LOCALAPPDATA: "D:\\Users\\chester\\Local" },
    "C:\\Users\\chester",
  );
  assert.equal(root, "D:\\Users\\chester\\Local\\Flyto2 Runtime\\service");
  const paths = windowsRuntimeServicePaths(root);
  assert.ok(paths.taskXmlPath.endsWith("runtime-task.xml"));
  assert.ok(paths.previousTaskXmlPath.endsWith("runtime-task.xml.previous"));
});
