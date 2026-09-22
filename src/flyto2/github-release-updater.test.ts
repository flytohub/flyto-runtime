import assert from "node:assert/strict";
import test from "node:test";
import {
  latestFlyto2ReleaseArtifact,
  parseSha256,
} from "./github-release-updater.js";

test("GitHub release resolver requires the versioned Runtime tarball and checksum", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    tag_name: "v1.2.3",
    assets: [
      {
        name: "flyto2-runtime-1.2.3.tgz",
        browser_download_url: "https://example.test/runtime.tgz",
      },
      {
        name: "flyto2-runtime-1.2.3.tgz.sha256",
        browser_download_url: "https://example.test/runtime.tgz.sha256",
      },
    ],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  assert.deepEqual(
    await latestFlyto2ReleaseArtifact({
      fetchImpl,
      releaseApi: "https://example.test/releases/latest",
    }),
    {
      version: "1.2.3",
      tag: "v1.2.3",
      tarball_name: "flyto2-runtime-1.2.3.tgz",
      tarball_url: "https://example.test/runtime.tgz",
      checksum_name: "flyto2-runtime-1.2.3.tgz.sha256",
      checksum_url: "https://example.test/runtime.tgz.sha256",
    },
  );
});

test("checksum parser binds the digest to the expected release filename", () => {
  const digest = "a".repeat(64);
  assert.equal(
    parseSha256(
      `${digest}  flyto2-runtime-1.2.3.tgz\n`,
      "flyto2-runtime-1.2.3.tgz",
    ),
    digest,
  );
  assert.throws(
    () => parseSha256(
      `${digest}  different.tgz\n`,
      "flyto2-runtime-1.2.3.tgz",
    ),
    /instead of/,
  );
});
