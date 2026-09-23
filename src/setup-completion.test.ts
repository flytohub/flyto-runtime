import assert from "node:assert/strict";
import test from "node:test";
import {
  allConnectionDetails,
  backgroundServiceSummary,
  formatSetupCompletion,
} from "./setup-completion.js";

test("setup completion summarizes runtime, service, and connection details", () => {
  const output = formatSetupCompletion(
    {
      mcpUrl: "https://runtime.example/mcp",
      ownerPassword: "owner-secret",
      pluginPath: "/tmp/runtime.zip",
    },
    {
      healthOk: true,
      service: {
        supported: true,
        installed: true,
        loaded: true,
        state: "running",
      },
    },
  );

  assert.match(output, /Runtime: Running/);
  assert.match(output, /Health: OK/);
  assert.match(output, /Background service: running/);
  assert.match(output, /MCP URL: https:\/\/runtime\.example\/mcp/);
  assert.match(output, /Owner password: owner-secret/);
  assert.match(output, /ChatGPT plugin ZIP: \/tmp\/runtime\.zip/);
});

test("setup completion distinguishes installed and missing background services", () => {
  assert.equal(
    backgroundServiceSummary({ supported: true, installed: true, loaded: false }),
    "installed",
  );
  assert.equal(
    backgroundServiceSummary({ supported: true, installed: false, loaded: false }),
    "not installed",
  );
  assert.equal(
    backgroundServiceSummary({ supported: false, installed: false, loaded: false }),
    "not supported",
  );
});

test("copy-all payload contains connection secrets but no runtime diagnostics", () => {
  const output = allConnectionDetails({
    mcpUrl: "https://runtime.example/mcp",
    ownerPassword: "owner-secret",
  });
  assert.equal(
    output,
    "MCP URL: https://runtime.example/mcp\nOwner password: owner-secret",
  );
});
