import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  bundledCloudflaredPath,
  checkForAppUpdate,
  newerStableRelease,
  packagedDistribution,
  packagedLocationProblem,
} from "./distribution.js";

test("a source checkout is not a packaged distribution; the app's marker is", (t) => {
  const root = mkdtempSync(join(tmpdir(), "distribution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(packagedDistribution(root), undefined);
  writeFileSync(join(root, "distribution.json"), JSON.stringify({ kind: "macos-app", version: "1.2.3", arch: "arm64" }));
  assert.deepEqual(packagedDistribution(root), { kind: "macos-app", version: "1.2.3", arch: "arm64" });
  writeFileSync(join(root, "distribution.json"), JSON.stringify({ kind: "windows-portable", version: "1.2.3", arch: "x64" }));
  assert.deepEqual(packagedDistribution(root), { kind: "windows-portable", version: "1.2.3", arch: "x64" });
  writeFileSync(join(root, "distribution.json"), JSON.stringify({ kind: "other" }));
  assert.throws(() => packagedDistribution(root), /not a valid/);
});

test("packaged cloudflared uses the native executable name", () => {
  assert.equal(bundledCloudflaredPath("/runtime", "darwin"), join("/runtime", "vendor", "cloudflared"));
  assert.equal(bundledCloudflaredPath("C:\\runtime", "win32"), join("C:\\runtime", "vendor", "cloudflared.exe"));
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

test("the app offers only a newer promoted stable Runtime from the flyto2 release page", async () => {
  const channel = {
    product: "runtime",
    state: "promoted",
    version: "1.2.0",
    release_url: "https://github.com/flytohub/flyto2/releases/tag/runtime/v1.2.0",
  };
  assert.deepEqual(newerStableRelease(channel, "1.1.0"), { version: "1.2.0", url: channel.release_url });
  assert.equal(newerStableRelease(channel, "1.2.0"), undefined);
  assert.equal(newerStableRelease(channel, "1.3.0"), undefined);
  assert.equal(newerStableRelease({ ...channel, state: "unpromoted" }, "1.1.0"), undefined);
  assert.equal(newerStableRelease({ ...channel, product: "flow" }, "1.1.0"), undefined);
  assert.equal(newerStableRelease({ ...channel, release_url: "https://evil.example/runtime" }, "1.1.0"), undefined);
  assert.equal(newerStableRelease(null, "1.1.0"), undefined);

  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.equal(await checkForAppUpdate("1.1.0", offline), undefined);
  const serving = (async () => ({ ok: true, json: async () => channel })) as unknown as typeof fetch;
  assert.deepEqual(await checkForAppUpdate("1.1.0", serving), { version: "1.2.0", url: channel.release_url });
});

test("the merged release SBOM keeps CycloneDX identity required by GitHub attestation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "release-sbom-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = {
    $schema: "http://cyclonedx.org/schema/bom-1.7.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    metadata: { tools: { components: [] } },
  };
  writeFileSync(join(root, "sbom-arm64.cdx.json"), JSON.stringify({
    ...base,
    serialNumber: "urn:uuid:11111111-1111-4111-8111-111111111111",
    components: [{ type: "library", name: "shared", version: "1", purl: "pkg:npm/shared@1" }],
  }));
  writeFileSync(join(root, "sbom-x64.cdx.json"), JSON.stringify({
    ...base,
    serialNumber: "urn:uuid:22222222-2222-4222-8222-222222222222",
    components: [
      { type: "library", name: "shared", version: "1", purl: "pkg:npm/shared@1" },
      { type: "library", name: "x64-only", version: "1", purl: "pkg:npm/x64-only@1" },
    ],
  }));

  const script = fileURLToPath(new URL("../../scripts/release-candidate.mjs", import.meta.url));
  execFileSync(process.execPath, [script, "sbom", root], { stdio: "pipe" });
  const packageVersion = (JSON.parse(
    readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
  ) as { version: string }).version;
  const merged = JSON.parse(
    readFileSync(join(root, `flyto2-runtime-${packageVersion}.cdx.json`), "utf8"),
  ) as {
    $schema?: string;
    bomFormat?: string;
    specVersion?: string;
    serialNumber?: string;
    components?: unknown[];
  };

  assert.equal(merged.$schema, base.$schema);
  assert.equal(merged.bomFormat, "CycloneDX");
  assert.equal(merged.specVersion, "1.7");
  assert.match(merged.serialNumber ?? "", /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(merged.components?.length, 2);
});

test("the release manifest requires both macOS builds and the Windows x64 package", (t) => {
  const root = mkdtempSync(join(tmpdir(), "release-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageVersion = (JSON.parse(
    readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
  ) as { version: string }).version;
  for (const name of [
    `Flyto2-Runtime-${packageVersion}-macos-arm64.dmg`,
    `Flyto2-Runtime-${packageVersion}-macos-x64.dmg`,
    `Flyto2-Runtime-${packageVersion}-windows-x64.zip`,
  ]) {
    writeFileSync(join(root, name), name);
  }
  writeFileSync(
    join(root, `flyto2-runtime-${packageVersion}.cdx.json`),
    JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.7", components: [{ name: "runtime" }] }),
  );
  writeFileSync(join(root, "provenance.intoto.jsonl"), "{}\n");
  writeFileSync(join(root, "sbom.intoto.jsonl"), "{}\n");

  const script = fileURLToPath(new URL("../../scripts/release-candidate.mjs", import.meta.url));
  execFileSync(process.execPath, [script, "manifest", root], {
    stdio: "pipe",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "flytohub/flyto-runtime",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123",
      GITHUB_WORKFLOW_REF: "flytohub/flyto-runtime/.github/workflows/macos-app.yml@refs/heads/main",
    },
  });
  const manifest = JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")) as {
    artifacts: Array<{ name: string; platform: string; arch: string; kind: string; native_signature?: string }>;
  };
  assert.deepEqual(
    manifest.artifacts.map(({ name, platform, arch, kind }) => ({ name, platform, arch, kind })),
    [
      {
        name: `Flyto2-Runtime-${packageVersion}-macos-arm64.dmg`,
        platform: "macos",
        arch: "arm64",
        kind: "installer",
      },
      {
        name: `Flyto2-Runtime-${packageVersion}-macos-x64.dmg`,
        platform: "macos",
        arch: "x64",
        kind: "installer",
      },
      {
        name: `Flyto2-Runtime-${packageVersion}-windows-x64.zip`,
        platform: "windows",
        arch: "x64",
        kind: "archive",
      },
    ],
  );
  assert.equal(manifest.artifacts[0]?.native_signature, "apple-developer-id-notarized");
  assert.equal(manifest.artifacts[2]?.native_signature, undefined);
});

test("the Runtime candidate workflow attests macOS and Windows packages with explicit CycloneDX evidence", () => {
  const workflow = readFileSync(
    fileURLToPath(new URL("../../.github/workflows/macos-app.yml", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(workflow, /actions\/attest-sbom@/);
  assert.match(workflow, /Windows package \(x64\)/);
  assert.match(workflow, /scripts\/package-windows\.ps1/);
  assert.match(workflow, /subject-path:\s*candidate\/Flyto2-Runtime-\*/);
  assert.match(workflow, /actions\/attest@59d89421af93a897026c735860bf21b6eb4f7b26/);
  assert.match(workflow, /predicate-type:\s*https:\/\/cyclonedx\.org\/bom/);
  assert.match(workflow, /predicate-path:\s*candidate\/flyto2-runtime-\$\{\{ steps\.source\.outputs\.version \}\}\.cdx\.json/);
  assert.match(workflow, /Validate the merged SBOM/);
});

test("release gates accept exact-commit manual CI when automation pushes cannot trigger CI", () => {
  const ci = readFileSync(
    fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)),
    "utf8",
  );
  const candidate = readFileSync(
    fileURLToPath(new URL("../../.github/workflows/macos-app.yml", import.meta.url)),
    "utf8",
  );
  const release = readFileSync(
    fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url)),
    "utf8",
  );

  assert.match(ci, /workflow_dispatch:/);
  for (const workflow of [candidate, release]) {
    assert.match(workflow, /event == "push" or \.event == "workflow_dispatch"/);
    assert.doesNotMatch(workflow, /--event push/);
  }
});
