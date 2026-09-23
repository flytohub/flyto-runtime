import assert from "node:assert/strict";
import test from "node:test";
import {
  renderWindowsDesktopLauncher,
  windowsDesktopRoot,
} from "./windows-launcher.js";

test("Windows desktop launcher starts the same packaged CLI with durable config", () => {
  const content = renderWindowsDesktopLauncher({
    packageRoot: "C:\\Users\\Chester Hsu\\AppData\\Local\\Flyto2 Runtime\\releases\\v1",
    configDirectory: "C:\\Users\\Chester Hsu\\Flyto2 Config",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    mode: "start",
  });

  assert.match(content, /FLYTO2_RUNTIME_CONFIG_DIR/);
  assert.match(content, /DEVSPACE_CONFIG_DIR/);
  assert.match(content, /dist\\cli\.js/);
  assert.match(content, /service start/);
  assert.match(content, /Program Files/);
});

test("Windows desktop fallback path is deterministic off Windows", () => {
  assert.equal(
    windowsDesktopRoot("C:\\Users\\chester"),
    "C:\\Users\\chester\\Desktop",
  );
});
