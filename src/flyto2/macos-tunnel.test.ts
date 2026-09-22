import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FLYTO2_RUNTIME_TUNNEL_LABEL,
  FLYTO2_RUNTIME_TUNNEL_STANDBY_LABEL,
  loadNativeTunnelProfile,
  migrateLegacyCloudflareTunnel,
  nativeTunnelStatus,
  nativeTunnelPlistPath,
  renderNativeTunnelLaunchAgent,
  installNativeTunnelService,
  shouldRepairNativeTunnelRedundancy,
} from "./macos-tunnel.js";

test("tunnel redundancy repair triggers only for a partial connector failure", () => {
  assert.equal(shouldRepairNativeTunnelRedundancy({
    supported: true,
    configured: true,
    connector_count: 2,
    ready_connectors: 1,
    connectors: [
      { label: FLYTO2_RUNTIME_TUNNEL_LABEL, ready: true },
      { label: FLYTO2_RUNTIME_TUNNEL_STANDBY_LABEL, ready: false },
    ],
  }), true);
  assert.equal(shouldRepairNativeTunnelRedundancy({
    supported: true,
    configured: true,
    connector_count: 2,
    ready_connectors: 0,
    connectors: [
      { label: FLYTO2_RUNTIME_TUNNEL_LABEL, ready: false },
      { label: FLYTO2_RUNTIME_TUNNEL_STANDBY_LABEL, ready: false },
    ],
  }), false);
  assert.equal(shouldRepairNativeTunnelRedundancy({
    supported: true,
    configured: true,
    connector_count: 2,
    ready_connectors: 2,
    connectors: [
      { label: FLYTO2_RUNTIME_TUNNEL_LABEL, ready: true },
      { label: FLYTO2_RUNTIME_TUNNEL_STANDBY_LABEL, ready: true },
    ],
  }), false);
});

test("native tunnel launch agent is independent of the legacy Mac Kit supervisor", () => {
  const profile = {
    provider: "cloudflare" as const,
    hostname: "runtime.example.com",
    tunnel_id: "tunnel-123",
    binary_path: "/Users/example/Library/Application Support/Flyto2 Runtime/tunnel/cloudflared",
    config_path: "/Users/example/Library/Application Support/Flyto2 Runtime/tunnel/config.json",
    credentials_path: "/Users/example/Library/Application Support/Flyto2 Runtime/tunnel/credentials.json",
    migrated_at: "2026-09-22T00:00:00.000Z",
  };
  const plist = renderNativeTunnelLaunchAgent(profile, "/Users/example");

  assert.match(plist, new RegExp(FLYTO2_RUNTIME_TUNNEL_LABEL.replaceAll(".", "\\.")));
  assert.match(plist, /cloudflared/);
  assert.match(plist, /--no-autoupdate/);
  assert.match(plist, /tunnel-123/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>1<\/integer>/);
  assert.doesNotMatch(plist, /service\.mjs/);
  assert.doesNotMatch(plist, /local\.devspace\.mac-kit/);
});

test("legacy fixed tunnel assets migrate into Flyto2 Runtime-owned storage", {
  skip: platform() !== "darwin",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flyto2-tunnel-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const legacy = join(root, "legacy");
  const home = join(root, "home");
  const cloudflare = join(legacy, "cloudflare");
  const macKit = join(legacy, "mac-kit");
  const binary = join(legacy, "runtime", "cloudflared");
  const credentials = join(cloudflare, "legacy-credentials.json");
  const config = join(cloudflare, "legacy-config.json");

  await mkdir(join(legacy, "runtime"), { recursive: true });
  await mkdir(cloudflare, { recursive: true });
  await mkdir(macKit, { recursive: true });
  await writeFile(binary, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(credentials, "{\"secret\":\"opaque\"}\n", { mode: 0o600 });
  await writeFile(config, JSON.stringify({
    tunnel: "tunnel-123",
    "credentials-file": credentials,
    ingress: [
      { hostname: "runtime.example.com", service: "http://127.0.0.1:7676" },
      { service: "http_status:404" },
    ],
  }));
  await writeFile(join(macKit, "settings.json"), JSON.stringify({
    cloudflared: binary,
    tunnel: {
      hostname: "runtime.example.com",
      id: "tunnel-123",
      configFile: config,
    },
  }));

  const profile = migrateLegacyCloudflareTunnel(legacy, home);
  assert.equal(profile.hostname, "runtime.example.com");
  assert.equal(profile.tunnel_id, "tunnel-123");
  assert.ok(profile.binary_path.includes("Flyto2 Runtime"));
  assert.ok(profile.config_path.includes("Flyto2 Runtime"));
  assert.ok(profile.credentials_path.includes("Flyto2 Runtime"));
  assert.deepEqual(loadNativeTunnelProfile(home), profile);

  const migratedConfig = JSON.parse(
    await readFile(profile.config_path, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(migratedConfig["credentials-file"], profile.credentials_path);

  const loadedBeforeStage = nativeTunnelStatus(home).loaded;
  const status = installNativeTunnelService(home, false);
  assert.equal(status.configured, true);
  assert.equal(status.loaded, loadedBeforeStage);
  assert.equal(status.plist_path, nativeTunnelPlistPath(home));
  assert.equal(status.connector_count, 2);
  assert.equal(status.connectors.length, 2);
  const standbyPlistPath = nativeTunnelPlistPath(
    home,
    FLYTO2_RUNTIME_TUNNEL_STANDBY_LABEL,
  );
  assert.match(
    await readFile(standbyPlistPath, "utf8"),
    /local\.flyto2\.runtime\.tunnel\.standby/,
  );
  assert.match(
    await readFile(standbyPlistPath, "utf8"),
    /127\.0\.0\.1:20242/,
  );

  const initialPlist = await readFile(status.plist_path, "utf8");
  await writeFile(
    status.plist_path,
    initialPlist.replace("<integer>1</integer>", "<integer>9</integer>"),
  );
  installNativeTunnelService(home, false);
  assert.match(
    await readFile(`${status.plist_path}.previous`, "utf8"),
    /<integer>9<\/integer>/,
  );
  assert.match(
    await readFile(status.plist_path, "utf8"),
    /<key>ThrottleInterval<\/key>\s*<integer>1<\/integer>/,
  );
});
