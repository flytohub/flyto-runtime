import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  clipboardCommands,
  collectSetupStatus,
  connectionDetailsClipboardText,
  copyToClipboard,
  formatConnectionDetails,
  formatSetupStatus,
  maskSecret,
  probeRuntimeHealth,
  setupIsConnectable,
} from "./setup-completion.js";

const details = { mcpUrl: "https://runtime.example.com/mcp", ownerPassword: "owner-secret-1234" };

test("status reports each layer separately so a failure names its layer", async () => {
  const status = await collectSetupStatus({
    localBaseUrl: "http://127.0.0.1:1",
    publicBaseUrl: "https://runtime.example.com",
    fetchHealth: async (url) => (url.startsWith("http://127.0.0.1") ? "ok" : "unreachable"),
    serviceStatus: () => ({ supported: true, installed: true, loaded: true }),
  });
  assert.deepEqual(status, { local: "ok", publicEndpoint: "unreachable", service: "loaded" });
  assert.equal(setupIsConnectable(status), false);
  const lines = formatSetupStatus(status).join("\n");
  assert.match(lines, /\[ok\] Runtime: +Running/);
  assert.match(lines, /\[!!\] Public endpoint: +Unreachable/);
  assert.match(lines, /\[ok\] Background service: Loaded/);
});

test("a local-only setup is connectable without a public endpoint", async () => {
  const status = await collectSetupStatus({
    localBaseUrl: "http://127.0.0.1:1",
    publicBaseUrl: null,
    fetchHealth: async () => "ok",
  });
  assert.deepEqual(status, { local: "ok", publicEndpoint: "not_configured", service: "unsupported" });
  assert.equal(setupIsConnectable(status), true);
  assert.doesNotMatch(formatSetupStatus(status).join("\n"), /Public endpoint|Background service/);
});

test("health probe accepts only a Flyto2 Runtime health response", async (t) => {
  let body = { ok: true, name: "flyto2-runtime" };
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`;
  assert.equal(await probeRuntimeHealth(url), "ok");
  body = { ok: true, name: "devspace" };
  assert.equal(await probeRuntimeHealth(url), "foreign");
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await probeRuntimeHealth(url), "unreachable");
});

test("a legacy server on the Runtime port is reported as foreign, never as running", async () => {
  const status = await collectSetupStatus({
    localBaseUrl: "http://127.0.0.1:7676",
    publicBaseUrl: "https://runtime.example.com",
    fetchHealth: async () => "foreign",
    serviceStatus: () => ({ supported: true, installed: true, loaded: true }),
  });
  assert.equal(setupIsConnectable(status), false);
  const lines = formatSetupStatus(status).join("\n");
  assert.match(lines, /\[!!\] Runtime: +Port is held by another program/);
  assert.match(lines, /\[!!\] Public endpoint: +Reaches a different server/);
});

test("the Owner password is masked on screen unless revealed, and complete on the clipboard", () => {
  assert.equal(maskSecret("owner-secret-1234"), "*************1234");
  assert.equal(maskSecret("abc"), "***");
  assert.doesNotMatch(formatConnectionDetails(details, { revealPassword: false }).join("\n"), /owner-secret/);
  assert.match(formatConnectionDetails(details, { revealPassword: true }).join("\n"), /owner-secret-1234/);
  assert.equal(
    connectionDetailsClipboardText({ ...details, pluginPath: "/tmp/plugin.zip" }),
    "MCP URL:        https://runtime.example.com/mcp\nOwner password: owner-secret-1234\nChatGPT plugin: /tmp/plugin.zip",
  );
});

test("clipboard uses the platform tool over stdin and falls back on Linux", async () => {
  assert.deepEqual(clipboardCommands("darwin"), [{ command: "pbcopy", args: [] }]);
  assert.deepEqual(clipboardCommands("win32"), [{ command: "clip.exe", args: [] }]);
  const tried: string[] = [];
  const copied = await copyToClipboard("secret", "linux", async (command, input) => {
    tried.push(command.command);
    assert.equal(input, "secret");
    assert.ok(!command.args.includes("secret"));
    return command.command === "xclip";
  });
  assert.equal(copied, true);
  assert.deepEqual(tried, ["wl-copy", "xclip"]);
  assert.equal(await copyToClipboard("x", "linux", async () => false), false);
});
