#!/usr/bin/env node
// Assembles the release candidate that flytohub/flyto2 ingests: one CycloneDX
// SBOM for both Mac builds, SHA256SUMS over every distributed file, and a
// release manifest in the shape of flyto2's schemas/release-manifest.schema.json.
//
//   node scripts/release-candidate.mjs sbom <dir>
//     Merges <dir>/sbom-*.cdx.json into <dir>/flyto2-runtime-<version>.cdx.json.
//   node scripts/release-candidate.mjs manifest <dir>
//     Writes <dir>/SHA256SUMS and <dir>/release-manifest.json. Reads
//     GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_RUN_ID and GITHUB_WORKFLOW_REF.
//
// Standard library only, so the candidate job needs no install step.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const PRODUCT = "runtime";
const DISPLAY_NAME = "Flyto2 Runtime";
const DISTRIBUTION_TAG_PREFIX = "runtime/v";
const WORKFLOW = ".github/workflows/macos-app.yml";
const DMG = /^Flyto2-Runtime-(.+)-macos-(arm64|x64)\.dmg$/;

const [command, dir] = process.argv.slice(2);
if (!dir || (command !== "sbom" && command !== "manifest")) {
  console.error("Usage: release-candidate.mjs <sbom|manifest> <dir>");
  process.exit(2);
}
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const sbomName = `flyto2-runtime-${version}.cdx.json`;

if (command === "sbom") writeSbom();
else writeManifest();

function writeSbom() {
  const inputs = readdirSync(dir).filter((name) => /^sbom-.+\.cdx\.json$/.test(name)).sort();
  if (inputs.length === 0) throw new Error(`No sbom-*.cdx.json in ${dir}.`);
  const boms = inputs.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
  for (const [index, bom] of boms.entries()) {
    if (bom.bomFormat !== "CycloneDX") throw new Error(`${inputs[index]} is not a CycloneDX document.`);
  }
  // The two builds share almost every package; the rest are the
  // architecture-specific native packages. Keep each component once.
  const components = new Map();
  for (const bom of boms) {
    for (const component of bom.components ?? []) {
      const key = component.purl ?? `${component.type}:${component.name}@${component.version}`;
      if (!components.has(key)) components.set(key, component);
    }
  }
  const [first] = boms;
  const merged = {
    bomFormat: "CycloneDX",
    specVersion: first.specVersion,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: first.metadata?.tools,
      component: {
        type: "application",
        name: "flyto2-runtime",
        version,
        purl: `pkg:github/flytohub/flyto-runtime@v${version}`,
        description: `${DISPLAY_NAME} macOS app (${inputs.map((name) => name.slice(5, -9)).join(", ")})`,
      },
    },
    components: [...components.values()],
  };
  writeFileSync(join(dir, sbomName), JSON.stringify(merged, null, 2) + "\n");
  for (const name of inputs) rmSync(join(dir, name));
  console.log(`${sbomName}: ${merged.components.length} components from ${inputs.join(", ")}`);
}

function writeManifest() {
  const env = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set.`);
    return value;
  };
  const commit = env("GITHUB_SHA");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`GITHUB_SHA is not a commit id: ${commit}`);
  if (!env("GITHUB_WORKFLOW_REF").includes(`/${WORKFLOW}@`)) {
    throw new Error(`Candidates are built by ${WORKFLOW}, not ${env("GITHUB_WORKFLOW_REF")}.`);
  }

  const files = readdirSync(dir).filter((name) => name !== "SHA256SUMS" && name !== "release-manifest.json").sort();
  const digest = (name) => createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  const evidence = (name) => ({ path: name, sha256: digest(name) });

  const artifacts = files.filter((name) => DMG.test(name)).map((name) => {
    const [, dmgVersion, arch] = DMG.exec(name);
    if (dmgVersion !== version) throw new Error(`${name} is not version ${version}.`);
    return {
      name,
      platform: "macos",
      arch,
      kind: "installer",
      sha256: digest(name),
      size: statSync(join(dir, name)).size,
      native_signature: "apple-developer-id-notarized",
    };
  });
  if (artifacts.length === 0) throw new Error(`No disk images in ${dir}.`);
  for (const required of [sbomName, "provenance.intoto.jsonl", "sbom.intoto.jsonl"]) {
    if (!files.includes(required)) throw new Error(`${required} is missing from ${dir}.`);
  }

  writeFileSync(join(dir, "SHA256SUMS"), files.map((name) => `${digest(name)}  ${name}\n`).join(""));

  const sbom = JSON.parse(readFileSync(join(dir, sbomName), "utf8"));
  const manifest = {
    schema_version: 1,
    product: PRODUCT,
    display_name: DISPLAY_NAME,
    version,
    channel: version.includes("-") ? "beta" : "stable",
    distribution_tag: `${DISTRIBUTION_TAG_PREFIX}${version}`,
    released_at: new Date().toISOString(),
    source: { repository: env("GITHUB_REPOSITORY"), commit, tag: `v${version}` },
    build: { workflow: WORKFLOW, run_id: Number(env("GITHUB_RUN_ID")), builder: "github-actions" },
    artifacts,
    checksums: evidence("SHA256SUMS"),
    sbom: { ...evidence(sbomName), format: "CycloneDX", spec_version: sbom.specVersion },
    provenance: { ...evidence("provenance.intoto.jsonl"), type: "github-artifact-attestation" },
    attestations: [{ ...evidence("sbom.intoto.jsonl"), type: "github-artifact-attestation", predicate: "https://cyclonedx.org/bom" }],
  };
  writeFileSync(join(dir, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`release-manifest.json: ${manifest.distribution_tag} from ${basename(dir)}, ${artifacts.length} installers`);
}
