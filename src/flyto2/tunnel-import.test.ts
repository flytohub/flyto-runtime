import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { importCloudflareTunnel } from "./tunnel-import.js";

test("Cloudflare tunnel import copies assets and rewrites credentials locally", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-tunnel-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = join(root, "source");
  const home = join(root, "home");
  await mkdir(source, { recursive: true });
  const binary = join(source, platform() === "win32" ? "cloudflared.exe" : "cloudflared");
  const credentials = join(source, "credentials.json");
  const configPath = join(source, "config.yml");
  await writeFile(binary, "fake cloudflared\n");
  if (platform() !== "win32") await chmod(binary, 0o700);
  await writeFile(credentials, JSON.stringify({ AccountTag: "test" }));
  await writeFile(configPath, YAML.stringify({
    tunnel: "12345678-1234-1234-1234-123456789012",
    "credentials-file": credentials,
    ingress: [
      { hostname: "runtime.example.com", service: "http://127.0.0.1:7676" },
      { service: "http_status:404" },
    ],
  }));

  const profile = importCloudflareTunnel({
    configPath,
    binaryPath: binary,
    homeDirectory: home,
    env: {},
    currentPlatform: platform(),
  });

  assert.equal(profile.hostname, "runtime.example.com");
  assert.equal(profile.tunnel_id, "12345678-1234-1234-1234-123456789012");
  assert.notEqual(profile.binary_path, binary);
  assert.notEqual(profile.credentials_path, credentials);

  const importedConfig = YAML.parse(
    await readFile(profile.config_path, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(importedConfig.tunnel, profile.tunnel_id);
  assert.equal(importedConfig["credentials-file"], profile.credentials_path);
  assert.equal(
    JSON.parse(await readFile(profile.credentials_path, "utf8")).AccountTag,
    "test",
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(
          platform() === "win32"
            ? join(home, "AppData", "Local", "Flyto2 Runtime")
            : platform() === "darwin"
              ? join(home, "Library", "Application Support", "Flyto2 Runtime")
              : join(home, ".local", "share", "flyto2-runtime"),
          "tunnel",
          "profile.json",
        ),
        "utf8",
      ),
    ).hostname,
    "runtime.example.com",
  );
});
