import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { valid as validSemver } from "semver";
import { strToU8, zipSync } from "fflate";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const DEFAULT_PLUGIN_NAME = "flyto2-runtime";
export const DEFAULT_PLUGIN_DISPLAY_NAME = "Flyto2 Runtime";
export const DEFAULT_PLUGIN_DESCRIPTION =
  "Connect ChatGPT and Codex to Flyto2 Runtime for workspace-scoped local development and automation.";

export const PORTABLE_TOOL_CATALOG_REVISIONS = {
  codex: "codex-v2",
  claude: "claude-v1",
} as const;

export type PortableToolMode = keyof typeof PORTABLE_TOOL_CATALOG_REVISIONS;

export function portablePluginServerName(
  name = DEFAULT_PLUGIN_NAME,
  toolMode: PortableToolMode = "codex",
): string {
  validatePluginName(name, "plugin name");
  return `${name}-${PORTABLE_TOOL_CATALOG_REVISIONS[toolMode]}`;
}

export interface PortablePluginPackageOptions {
  mcpUrl: string;
  version: string;
  name?: string;
  serverName?: string;
  displayName?: string;
  description?: string;
  outputPath?: string;
}

export interface PortablePluginPackageResult {
  outputPath: string;
  mcpUrl: string;
  name: string;
  serverName: string;
  displayName: string;
  version: string;
}

export function mcpUrlFromPublicBaseUrl(publicBaseUrl: string): string {
  const base = normalizeHttpsUrl(publicBaseUrl, "public base URL");
  return new URL("/mcp", base).toString();
}

export function normalizePortableMcpUrl(value: string): string {
  const url = normalizeHttpsUrl(value, "MCP URL");
  if (url.username || url.password) {
    throw new Error("MCP URL must not contain embedded credentials.");
  }
  if (url.search) {
    throw new Error("MCP URL must not contain query parameters or secrets.");
  }
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export function defaultPortablePluginOutputPath(
  name = DEFAULT_PLUGIN_NAME,
  homeDirectory = homedir(),
): string {
  validatePluginName(name, "plugin name");
  const downloads = join(homeDirectory, "Downloads");
  const parent = existsSync(downloads) ? downloads : homeDirectory;
  return join(parent, `${name}-chatgpt-plugin.zip`);
}

export function buildPortablePluginFiles(
  options: PortablePluginPackageOptions,
): Record<string, Uint8Array> {
  const resolved = resolvePackageOptions(options);
  const pluginJson = {
    $schema: PLUGIN_SCHEMA,
    name: resolved.name,
    version: resolved.version,
    description: resolved.description,
    extensions: {
      "com.openai": {
        interface: {
          displayName: resolved.displayName,
          shortDescription: resolved.description,
          longDescription: resolved.description,
        },
      },
    },
  };
  const mcpJson = {
    $schema: MCP_SCHEMA,
    mcpServers: {
      [resolved.serverName]: {
        type: "streamable-http",
        url: resolved.mcpUrl,
      },
    },
  };
  const skillDescription =
    `Use ${resolved.displayName} for workspace-scoped local development and automation through its MCP server.`;
  const skill = [
    "---",
    `name: ${resolved.name}`,
    `description: ${JSON.stringify(skillDescription)}`,
    "---",
    "",
    `Use the ${resolved.serverName} MCP server when the user asks to inspect, modify, test, build, deploy, or otherwise work with a local development workspace exposed by ${resolved.displayName}.`,
    "",
    "Follow the MCP server's workspace, allowed-root, authorization, and safety boundaries. Reuse an existing workspace handle when available. Do not broaden filesystem access or bypass Runtime restrictions.",
    "",
    "Prefer dedicated file tools for reading and editing files. Use command execution for tests, builds, Git operations, deployment commands, and other supported development workflows.",
    "",
  ].join("\n");

  return {
    "plugin.json": strToU8(`${JSON.stringify(pluginJson, null, 2)}\n`),
    "mcp.json": strToU8(`${JSON.stringify(mcpJson, null, 2)}\n`),
    [`skills/${resolved.name}/SKILL.md`]: strToU8(skill),
  };
}

export async function writePortablePluginPackage(
  options: PortablePluginPackageOptions,
): Promise<PortablePluginPackageResult> {
  const resolved = resolvePackageOptions(options);
  const outputPath = resolve(
    options.outputPath ?? defaultPortablePluginOutputPath(resolved.name),
  );
  if (basename(outputPath) === "." || !outputPath.toLowerCase().endsWith(".zip")) {
    throw new Error("Plugin output path must end in .zip.");
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const archive = zipSync(buildPortablePluginFiles({ ...options, outputPath }), {
    level: 9,
  });
  await writeFile(outputPath, archive, { mode: 0o600 });

  return {
    outputPath,
    mcpUrl: resolved.mcpUrl,
    name: resolved.name,
    serverName: resolved.serverName,
    displayName: resolved.displayName,
    version: resolved.version,
  };
}

function resolvePackageOptions(options: PortablePluginPackageOptions): {
  mcpUrl: string;
  version: string;
  name: string;
  serverName: string;
  displayName: string;
  description: string;
} {
  const name = options.name?.trim() || DEFAULT_PLUGIN_NAME;
  const serverName = options.serverName?.trim() || name;
  const displayName = options.displayName?.trim() || DEFAULT_PLUGIN_DISPLAY_NAME;
  const description = options.description?.trim() || DEFAULT_PLUGIN_DESCRIPTION;
  const version = options.version.trim();

  validatePluginName(name, "plugin name");
  validateMcpServerName(serverName);
  if (!displayName) throw new Error("Plugin display name must not be empty.");
  if (!description) throw new Error("Plugin description must not be empty.");
  if (!validSemver(version)) {
    throw new Error(`Plugin version must be valid SemVer; got ${JSON.stringify(version)}.`);
  }

  return {
    mcpUrl: normalizePortableMcpUrl(options.mcpUrl),
    version,
    name,
    serverName,
    displayName,
    description,
  };
}

function validatePluginName(value: string, label: string): void {
  if (!PLUGIN_NAME_PATTERN.test(value)) {
    throw new Error(
      `${label} must use lowercase kebab-case (letters, digits, and single hyphens); got ${JSON.stringify(value)}.`,
    );
  }
}

function validateMcpServerName(value: string): void {
  if (!MCP_SERVER_NAME_PATTERN.test(value)) {
    throw new Error(
      `MCP server name must use letters, digits, dots, underscores, or hyphens; got ${JSON.stringify(value)}.`,
    );
  }
}

function normalizeHttpsUrl(value: string, label: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `${label} must use HTTPS for a portable ChatGPT plugin; got ${url.protocol || "unknown protocol"}.`,
    );
  }
  return url;
}
