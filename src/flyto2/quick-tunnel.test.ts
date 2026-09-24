import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cloudflaredInstallCommand,
  fetchQuickTunnelHostname,
  locateCloudflared,
  quickTunnelArguments,
  quickTunnelUrlChange,
  readQuickTunnelProfile,
  waitForPublicDns,
  waitForQuickTunnelHostname,
  writeQuickTunnelProfile,
} from "./quick-tunnel.js";
import { renderMacOneShotAgent } from "./macos-service.js";

const reply = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

test("the quick tunnel serves the Runtime port and reports on its own metrics port", () => {
  assert.deepEqual(quickTunnelArguments({ metrics_port: 20243, origin_port: 7676 }), [
    "tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:20243", "--url", "http://127.0.0.1:7676",
  ]);
});

test("only a trycloudflare hostname from cloudflared is trusted", async () => {
  assert.equal(await fetchQuickTunnelHostname(1, reply({ hostname: "blue-sky-42.trycloudflare.com" })), "blue-sky-42.trycloudflare.com");
  assert.equal(await fetchQuickTunnelHostname(1, reply({ hostname: "evil.example.com" })), undefined);
  assert.equal(await fetchQuickTunnelHostname(1, reply({ hostname: "" })), undefined);
  assert.equal(await fetchQuickTunnelHostname(1, reply({}, false)), undefined);
  assert.equal(await fetchQuickTunnelHostname(1, (async () => { throw new Error("refused"); }) as unknown as typeof fetch), undefined);
});

test("setup waits for cloudflared to publish its URL", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return { ok: true, json: async () => (calls < 3 ? {} : { hostname: "late-url.trycloudflare.com" }) };
  }) as unknown as typeof fetch;
  assert.equal(await waitForQuickTunnelHostname(1, { fetchImpl, sleep: async () => {} }), "late-url.trycloudflare.com");
  assert.equal(calls, 3);
  assert.equal(await waitForQuickTunnelHostname(1, { fetchImpl: reply({}), timeoutMs: 0, sleep: async () => {} }), undefined);
});

test("Runtime switches only when cloudflared reports a different URL", () => {
  assert.equal(quickTunnelUrlChange("https://old-one.trycloudflare.com", "new-one.trycloudflare.com"), "https://new-one.trycloudflare.com");
  assert.equal(quickTunnelUrlChange("https://same.trycloudflare.com", "same.trycloudflare.com"), undefined);
  assert.equal(quickTunnelUrlChange("https://same.trycloudflare.com", undefined), undefined);
  assert.equal(quickTunnelUrlChange("not a url", "fresh.trycloudflare.com"), "https://fresh.trycloudflare.com");
});

test("cloudflared is found off PATH in the Homebrew locations launchd does not see", () => {
  assert.equal(locateCloudflared("darwin", () => "/custom/cloudflared"), "/custom/cloudflared");
  assert.equal(locateCloudflared("darwin", () => undefined, (path) => path === "/usr/local/bin/cloudflared"), "/usr/local/bin/cloudflared");
  assert.equal(locateCloudflared("darwin", () => undefined, () => false), undefined);
});

test("cloudflared is installed only through the platform package manager", () => {
  assert.deepEqual(cloudflaredInstallCommand("darwin", (c) => c === "brew"), { command: "brew", args: ["install", "cloudflared"] });
  assert.equal(cloudflaredInstallCommand("darwin", () => false), undefined);
  assert.equal(cloudflaredInstallCommand("win32", (c) => c === "winget")?.command, "winget");
  assert.equal(cloudflaredInstallCommand("linux", () => true), undefined);
});

test("the quick tunnel profile round-trips and rejects malformed files", (t) => {
  const home = mkdtempSync(join(tmpdir(), "quick-tunnel-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(readQuickTunnelProfile(home), undefined);
  writeQuickTunnelProfile(home, { binary_path: "/bin/cloudflared", metrics_port: 20243, origin_port: 7676 });
  assert.deepEqual(readQuickTunnelProfile(home), { binary_path: "/bin/cloudflared", metrics_port: 20243, origin_port: 7676 });
});

test("the macOS quick tunnel agent is kept alive with a restart throttle", () => {
  const plist = renderMacOneShotAgent({
    label: "local.flyto2.runtime.quicktunnel",
    programArguments: ["/opt/homebrew/bin/cloudflared", "tunnel"],
    environment: {},
    logPath: "/tmp/qt.log",
    keepAlive: true,
  });
  assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>\n  <key>ThrottleInterval<\/key>\n  <integer>5<\/integer>/);
});

test("setup waits for the new hostname to exist in DNS before anything resolves it", async () => {
  let lookups = 0;
  const resolve = async () => {
    lookups += 1;
    if (lookups < 3) throw Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    return ["104.16.230.132"];
  };
  let fallbackLookups = 0;
  const fallbackResolve = async () => {
    fallbackLookups += 1;
    return ["104.16.230.132"];
  };
  await waitForPublicDns("fresh.trycloudflare.com", { resolve, fallbackResolve, sleep: async () => {} });
  assert.equal(lookups, 3);
  // The caching system resolver must not be asked while the record is missing.
  assert.equal(fallbackLookups, 0);
  await assert.rejects(
    waitForPublicDns("never.trycloudflare.com", {
      resolve: async () => { throw new Error("ENOTFOUND"); },
      fallbackResolve: async () => { throw new Error("ENOTFOUND"); },
      timeoutMs: 0,
      sleep: async () => {},
    }),
    /did not appear in public DNS/,
  );
});

test("a network that blocks direct DNS still finds the hostname through the system resolver at the deadline", async () => {
  await waitForPublicDns("blocked.trycloudflare.com", {
    resolve: async () => { throw Object.assign(new Error("queryA ETIMEOUT"), { code: "ETIMEOUT" }); },
    fallbackResolve: async () => ["104.16.230.132"],
    timeoutMs: 0,
    sleep: async () => {},
  });
});
