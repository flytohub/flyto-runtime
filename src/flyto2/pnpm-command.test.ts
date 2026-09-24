import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { pinnedPnpmVersion, pnpmInvocation } from "./pnpm-command.js";

const only = (...present: string[]) => (command: string) => present.includes(command);

test("pnpm is found without enabling corepack, in the launchers' order", () => {
  assert.deepEqual(pnpmInvocation({ platform: "darwin", has: only("pnpm", "corepack", "npm"), version: "11.25.0" }), ["pnpm"]);
  assert.deepEqual(pnpmInvocation({ platform: "darwin", has: only("corepack", "npm"), version: "11.25.0" }), ["corepack", "pnpm"]);
  assert.deepEqual(
    pnpmInvocation({ platform: "darwin", has: only("npm"), version: "11.25.0" }),
    ["npm", "exec", "--yes", "--package=pnpm@11.25.0", "--", "pnpm"],
  );
  assert.deepEqual(pnpmInvocation({ platform: "win32", has: only("corepack.cmd"), version: "11.25.0" }), ["corepack.cmd", "pnpm"]);
  assert.equal(pnpmInvocation({ platform: "darwin", has: only(), version: "11.25.0" }), undefined);
});

test("the pinned pnpm version comes from package.json", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { packageManager?: unknown };
  assert.match(pinnedPnpmVersion(packageJson.packageManager), /^\d+\.\d+\.\d+$/);
  assert.equal(pinnedPnpmVersion("pnpm@11.25.0+sha512.abc"), "11.25.0");
  assert.throws(() => pinnedPnpmVersion("yarn@4.0.0"), /must pin pnpm/);
});

test("both launchers resolve pnpm the same way and never run corepack enable", () => {
  for (const launcher of ["Flyto2 Runtime.command", "Flyto2 Runtime.cmd"]) {
    const script = readFileSync(new URL(`../../${launcher}`, import.meta.url), "utf8");
    assert.doesNotMatch(script, /corepack enable/, launcher);
    assert.match(script, /corepack(\.cmd)? pnpm/, launcher);
    assert.match(script, /exec --yes --package=pnpm@/, launcher);
  }
});

test("the build script does not call pnpm, which `corepack pnpm` leaves off PATH", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.doesNotMatch(packageJson.scripts.build, /\bpnpm\b/);
});
