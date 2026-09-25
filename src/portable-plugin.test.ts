import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import {
  buildPortablePluginFiles,
  defaultPortablePluginOutputPath,
  mcpUrlFromPublicBaseUrl,
  normalizePortableMcpUrl,
  portablePluginServerName,
  writePortablePluginPackage,
} from "./portable-plugin.js";

test("portable plugin derives the MCP resource from any configured HTTPS origin", () => {
  assert.equal(
    mcpUrlFromPublicBaseUrl("https://runtime.customer.example"),
    "https://runtime.customer.example/mcp",
  );
  assert.equal(
    mcpUrlFromPublicBaseUrl("https://runtime.customer.example/base/path"),
    "https://runtime.customer.example/mcp",
  );
});

test("portable plugin refuses insecure remote URLs and credential-bearing URLs", () => {
  assert.throws(
    () => normalizePortableMcpUrl("http://runtime.example/mcp"),
    /must use HTTPS/,
  );
  assert.throws(
    () => normalizePortableMcpUrl("https://owner:secret@runtime.example/mcp"),
    /must not contain embedded credentials/,
  );
  assert.throws(
    () => normalizePortableMcpUrl("https://runtime.example/mcp?token=secret"),
    /must not contain query parameters/,
  );
});

test("portable plugin catalog identity changes with the model-facing tool surface", () => {
  assert.equal(portablePluginServerName("flyto2-runtime", "codex"), "flyto2-runtime-codex-v2");
  assert.equal(portablePluginServerName("flyto2-runtime", "claude"), "flyto2-runtime-claude-v1");
});

test("portable plugin package keeps URL and identity configurable", () => {
  const files = buildPortablePluginFiles({
    mcpUrl: "https://customer.example/mcp",
    version: "2.4.1",
    name: "acme-runtime",
    serverName: "acme-mcp",
    displayName: "Acme Runtime",
    description: "Connect to the Acme runtime.",
  });

  const plugin = JSON.parse(strFromU8(files["plugin.json"]!)) as {
    name: string;
    version: string;
    description: string;
    extensions?: {
      "com.openai"?: {
        interface?: { displayName?: string };
      };
    };
  };
  const mcp = JSON.parse(strFromU8(files["mcp.json"]!)) as {
    mcpServers: Record<string, { type: string; url: string }>;
  };
  const skill = strFromU8(files["skills/acme-runtime/SKILL.md"]!);

  assert.equal(plugin.name, "acme-runtime");
  assert.equal(plugin.version, "2.4.1");
  assert.equal(plugin.description, "Connect to the Acme runtime.");
  assert.equal(plugin.extensions?.["com.openai"]?.interface?.displayName, "Acme Runtime");
  assert.deepEqual(mcp.mcpServers["acme-mcp"], {
    type: "streamable-http",
    url: "https://customer.example/mcp",
  });
  assert.match(skill, /name: acme-runtime/);
  assert.match(skill, /Acme Runtime/);
  assert.doesNotMatch(skill, /devspace\.flyto2\.com/);
});

test("portable plugin writes an upload-ready zip without credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "flyto2-plugin-package-"));
  try {
    const outputPath = join(root, "custom.zip");
    const result = await writePortablePluginPackage({
      mcpUrl: "https://runtime.example/mcp",
      version: "1.2.3",
      outputPath,
    });

    assert.equal(result.outputPath, outputPath);
    const archive = unzipSync(readFileSync(outputPath));
    assert.deepEqual(Object.keys(archive).sort(), [
      "mcp.json",
      "plugin.json",
      "skills/flyto2-runtime/SKILL.md",
    ]);
    const combined = Object.values(archive).map((value) => strFromU8(value)).join("\n");
    assert.match(combined, /https:\/\/runtime\.example\/mcp/);
    assert.doesNotMatch(
      combined,
      /ownerToken|"authorization"\s*:|Authorization:|Bearer\s+[A-Za-z0-9]/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable plugin default output goes to Downloads when available", () => {
  const root = mkdtempSync(join(tmpdir(), "flyto2-plugin-output-"));
  try {
    mkdirSync(join(root, "Downloads"));
    assert.equal(
      defaultPortablePluginOutputPath("team-runtime", root),
      join(root, "Downloads", "team-runtime-chatgpt-plugin.zip"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
