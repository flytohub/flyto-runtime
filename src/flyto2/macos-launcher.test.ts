import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installMacDesktopLaunchers,
  macDesktopLauncherStatus,
  removeMacDesktopLaunchers,
} from "./macos-launcher.js";

test("macOS launcher install creates executable desktop shortcuts to one Runtime entrypoint", {
  skip: platform() !== "darwin",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const packageRoot = join(root, "runtime");
  const desktopRoot = join(root, "Desktop");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "Flyto2 Runtime.command"), "#!/bin/bash\n", { mode: 0o700 });

  const installed = installMacDesktopLaunchers(packageRoot, desktopRoot);
  assert.equal(installed.directory, join(desktopRoot, "Flyto2 Runtime"));
  assert.equal(installed.launchers.length, 4);
  assert.equal(macDesktopLauncherStatus(desktopRoot).installed, true);

  for (const launcher of installed.launchers) {
    const mode = (await stat(launcher)).mode & 0o777;
    assert.equal(mode, 0o700);
    const body = await readFile(launcher, "utf8");
    assert.match(body, /Flyto2 Runtime\.command/);
    assert.match(body, /^#!\/bin\/bash/m);
  }

  assert.match(
    await readFile(join(installed.directory, "Flyto2 Runtime.command"), "utf8"),
    /'menu'/,
  );
  assert.match(
    await readFile(join(installed.directory, "啟動 Flyto2 Runtime.command"), "utf8"),
    /'start'/,
  );

  removeMacDesktopLaunchers(desktopRoot);
  assert.equal(macDesktopLauncherStatus(desktopRoot).installed, false);
});
