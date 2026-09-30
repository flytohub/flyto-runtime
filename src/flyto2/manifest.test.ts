import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { writeTestDevspaceConfig } from "../test-support/config.test.js";
import { runtimeCapability } from "./capability-catalog.js";
import { runtimeManifest } from "./manifest.js";

test("runtime manifest can describe only the capabilities registered by a composed Runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-runtime-manifest-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    storage: { stateDir: join(root, ".state") },
  }));
  const sourceRead = runtimeCapability("source.read");
  assert.ok(sourceRead);

  const manifest = runtimeManifest(config, [sourceRead]);
  assert.deepEqual(manifest.capabilities.map(({ id }) => id), ["source.read"]);
});
