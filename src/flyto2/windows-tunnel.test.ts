import assert from "node:assert/strict";
import test from "node:test";
import {
  WINDOWS_TUNNEL_CONNECTORS,
  renderWindowsTunnelTask,
  windowsNativeRuntimeHome,
  windowsTunnelProfilePath,
} from "./windows-tunnel.js";

const profile = {
  provider: "cloudflare" as const,
  hostname: "runtime.example.com",
  tunnel_id: "tunnel-123",
  binary_path: "C:\\Program Files\\cloudflared\\cloudflared.exe",
  config_path: "C:\\Users\\chester\\Flyto2 Runtime\\tunnel\\config.json",
  credentials_path: "C:\\Users\\chester\\Flyto2 Runtime\\tunnel\\credentials.json",
  migrated_at: "2026-09-23T00:00:00.000Z",
};

test("Windows tunnel tasks are redundant and use independent metrics ports", () => {
  assert.equal(WINDOWS_TUNNEL_CONNECTORS.length, 2);
  assert.deepEqual(
    WINDOWS_TUNNEL_CONNECTORS.map((entry) => entry.metricsPort),
    [20_241, 20_242],
  );

  const primary = renderWindowsTunnelTask(
    profile,
    WINDOWS_TUNNEL_CONNECTORS[0]!,
    "PC\\chester",
  );
  const standby = renderWindowsTunnelTask(
    profile,
    WINDOWS_TUNNEL_CONNECTORS[1]!,
    "PC\\chester",
  );
  for (const xml of [primary, standby]) {
    assert.match(xml, /cloudflared\.exe/);
    assert.match(xml, /--no-autoupdate/);
    assert.match(xml, /run tunnel-123/);
    assert.match(xml, /<RestartOnFailure>/);
    assert.match(xml, /<Interval>PT1M<\/Interval>/);
    assert.match(xml, /<Count>255<\/Count>/);
  }
  assert.match(primary, /--protocol quic/);
  assert.match(standby, /--protocol http2/);
  assert.match(primary, /127\.0\.0\.1:20241/);
  assert.match(standby, /127\.0\.0\.1:20242/);
});

test("Windows tunnel profile lives in LOCALAPPDATA with an explicit override", () => {
  assert.equal(
    windowsNativeRuntimeHome(
      { LOCALAPPDATA: "D:\\Local" },
      "C:\\Users\\chester",
    ),
    "D:\\Local\\Flyto2 Runtime",
  );
  assert.equal(
    windowsTunnelProfilePath(
      { FLYTO2_RUNTIME_TUNNEL_PROFILE: "E:\\flyto2\\profile.json" },
      "C:\\Users\\chester",
    ),
    "E:\\flyto2\\profile.json",
  );
});
