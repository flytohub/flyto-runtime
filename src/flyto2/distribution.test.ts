import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packagedDistribution, packagedLocationProblem } from "./distribution.js";

test("a source checkout is not a packaged distribution; the app's marker is", (t) => {
  const root = mkdtempSync(join(tmpdir(), "distribution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(packagedDistribution(root), undefined);
  writeFileSync(join(root, "distribution.json"), JSON.stringify({ kind: "macos-app", version: "1.2.3", arch: "arm64" }));
  assert.deepEqual(packagedDistribution(root), { kind: "macos-app", version: "1.2.3", arch: "arm64" });
  writeFileSync(join(root, "distribution.json"), JSON.stringify({ kind: "other" }));
  assert.throws(() => packagedDistribution(root), /not a valid/);
});

test("the app refuses to install its service from a place that goes away", () => {
  const inApp = "/Contents/Resources/runtime";
  assert.match(packagedLocationProblem(`/Volumes/Flyto2 Runtime/Flyto2 Runtime.app${inApp}`) ?? "", /disk image/);
  assert.match(
    packagedLocationProblem(`/private/var/folders/x/AppTranslocation/ABC/d/Flyto2 Runtime.app${inApp}`) ?? "",
    /temporary copy/,
  );
  assert.equal(packagedLocationProblem(`/Applications/Flyto2 Runtime.app${inApp}`), undefined);
  assert.equal(packagedLocationProblem(`/Users/u/Applications/Flyto2 Runtime.app${inApp}`), undefined);
});
