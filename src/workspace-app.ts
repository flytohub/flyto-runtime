import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Response } from "express";
import type { ServerConfig } from "./config.js";

const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function stripLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value[start] === "/") start += 1;
  return value.slice(start);
}

function assetBaseUrl(config: ServerConfig): string {
  return `${stripTrailingSlashes(config.publicBaseUrl)}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${stripLeadingSlashes(assetPath)}`;
}

/** Render the host-facing workspace app shell using the current public Runtime URL. */
export function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

/** Return the CSP origins required by the workspace app assets. */
export function workspaceAppCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = stripTrailingSlashes(config.publicBaseUrl);
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

/** Resolve the packaged Vite UI directory served by the Runtime HTTP server. */
export function workspaceAppBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

/** Apply cross-origin headers required for MCP-hosted workspace app assets. */
export function setWorkspaceAppAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

/** Fail startup early when the built workspace app manifest references missing assets. */
export async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}
