import { resolve as resolvePath, sep as pathSeparator } from "node:path";
import type { SubagentsConfig } from "./local-agent-config.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export const SUBAGENT_SKILL_INSTALL_COMMAND =
  "npx skills add flytohub/flyto-runtime --skill subagents --global";

export const ONBOARDING_DESTINATIONS = ["chatgpt", "codex", "claude", "custom", "coding-agents"] as const;
export type OnboardingDestination = typeof ONBOARDING_DESTINATIONS[number];
export type OnboardingUsage = OnboardingDestination | "both";

export function resolveOnboardingUsage(
  destinations: readonly OnboardingDestination[],
): OnboardingUsage {
  const selected = new Set(destinations);
  const local = ["codex", "claude", "custom", "coding-agents"].some((id) => selected.has(id as OnboardingDestination));
  if (selected.has("chatgpt") && local) return "both";
  if (selected.has("chatgpt")) return "chatgpt";
  if (local) return "coding-agents";
  throw new Error("Choose ChatGPT, Coding Agents, or both.");
}

export function usesChatGpt(usage: OnboardingUsage): boolean {
  return usage === "chatgpt" || usage === "both";
}

export function usesCodingAgents(usage: OnboardingUsage): boolean {
  return usage === "coding-agents" || usage === "both";
}

export function resolveToolModeForDestinations(
  destinations: readonly OnboardingDestination[],
): "codex" | "claude" | undefined {
  const selected = new Set(destinations);
  if (selected.has("chatgpt") || selected.has("codex")) return "codex";
  if (selected.has("claude")) return "claude";
  return undefined;
}

export function updateOnboardingSubagentsConfig(
  current: SubagentsConfig,
  selectedProviders: readonly LocalAgentProvider[],
): SubagentsConfig {
  const selected = new Set(selectedProviders);
  return {
    enabled: selected.size > 0,
    instructions: current.instructions,
    providers: LOCAL_AGENT_PROVIDERS
      .filter((id) => selected.has(id) || current.providers.some((provider) => provider.id === id))
      .map((id) => {
        const existing = current.providers.find((provider) => provider.id === id);
        return {
          ...existing,
          id,
          enabled: selected.has(id),
        };
      }),
  };
}

export const ONBOARDING_CLIENT_OPTIONS = [
  { value: "chatgpt", label: "ChatGPT", hint: "Connect through HTTPS with the compact six-tool surface." },
  { value: "codex", label: "Codex", hint: "Show connection instructions; no client is registered automatically." },
  { value: "claude", label: "Claude", hint: "Connect Claude Code or another Claude MCP client." },
  { value: "custom", label: "Direct MCP / custom client", hint: "Use Streamable HTTP with OAuth; Cloud is optional." },
] satisfies { value: OnboardingDestination; label: string; hint: string }[];

export function clientConnectionInstructions(client: OnboardingDestination, url: string): string {
  const quoted = "'" + url.replaceAll("'", "'\\''") + "'";
  switch (client) {
    case "codex":
      return `codex mcp add flyto2-runtime --url ${quoted}\ncodex mcp login flyto2-runtime`;
    case "claude":
      return `claude mcp add --transport http flyto2-runtime ${quoted}\nOpen /mcp in Claude Code to authorize. Other Claude clients: add the URL as a remote MCP server.`;
    case "chatgpt":
      return [
        "Create an upload-ready plugin with:",
        "  flyto2-runtime plugin build",
        `The generated package will point to ${url}.`,
        "Upload the ZIP in ChatGPT Plugins, then approve OAuth access with your Owner password.",
        "If this Runtime was already connected, refresh or recreate its ChatGPT app so ChatGPT scans the current tools.",
      ].join("\n");
    default:
      return `Streamable HTTP MCP URL: ${url}\nUse OAuth discovery and approve access with your Owner password. Flyto2 Cloud is not required.`;
  }
}

// The launcher starts inside the Runtime's own install directory, so the
// working directory is only a sensible default when it is a real project:
// never the Runtime itself, never the whole home directory.
export function suggestedProjectRoots(options: {
  configuredRoots: string[];
  cwd: string;
  homeDirectory: string;
  runtimePackageRoot: string;
}): string {
  if (options.configuredRoots.length > 0) return options.configuredRoots.join(", ");
  const cwd = resolvePath(options.cwd);
  const runtimeRoot = resolvePath(options.runtimePackageRoot);
  const insideRuntime = cwd === runtimeRoot || cwd.startsWith(`${runtimeRoot}${pathSeparator}`);
  if (insideRuntime || cwd === resolvePath(options.homeDirectory)) return "";
  return cwd;
}
