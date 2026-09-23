import assert from "node:assert/strict";
import {
  resolveOnboardingUsage,
  resolveToolModeForDestinations,
  ONBOARDING_CLIENT_OPTIONS,
  clientConnectionInstructions,
  updateOnboardingSubagentsConfig,
} from "./onboarding.js";

for (const [selections, expected] of [
  [["chatgpt"], "chatgpt"],
  [["codex"], "coding-agents"],
  [["claude", "custom"], "coding-agents"],
  [["chatgpt", "codex"], "both"],
  [["coding-agents"], "coding-agents"],
  [["coding-agents", "chatgpt"], "both"],
] as const) {
  assert.equal(resolveOnboardingUsage(selections), expected);
}
assert.throws(() => resolveOnboardingUsage([]), /Choose ChatGPT, Coding Agents, or both/);

assert.equal(resolveToolModeForDestinations(["chatgpt"]), "codex");
assert.equal(resolveToolModeForDestinations(["chatgpt", "claude"]), "codex");
assert.equal(resolveToolModeForDestinations(["codex"]), "codex");
assert.equal(resolveToolModeForDestinations(["claude"]), "claude");
assert.equal(resolveToolModeForDestinations(["custom"]), undefined);

assert.deepEqual(
  updateOnboardingSubagentsConfig(
    { enabled: false, instructions: "on-demand", providers: [] },
    ["codex", "claude"],
  ),
  {
    enabled: true,
    instructions: "on-demand",
    providers: [
      { id: "codex", enabled: true },
      { id: "claude", enabled: true },
    ],
  },
);

const configured = {
  enabled: true,
  instructions: "preload" as const,
  providers: [
    {
      id: "codex" as const,
      enabled: true,
      model: "gpt-5.4",
      effort: "high",
      command: "/opt/bin/codex-wrapper",
      env: { OPENAI_API_KEY: "configured", EMPTY_VALUE: "" },
    },
    { id: "claude" as const, enabled: true, model: "sonnet" },
  ],
};
assert.deepEqual(
  updateOnboardingSubagentsConfig(configured, ["claude"]),
  {
    enabled: true,
    instructions: "preload",
    providers: [
      {
        id: "codex",
        enabled: false,
        model: "gpt-5.4",
        effort: "high",
        command: "/opt/bin/codex-wrapper",
        env: { OPENAI_API_KEY: "configured", EMPTY_VALUE: "" },
      },
      { id: "claude", enabled: true, model: "sonnet" },
    ],
  },
);

assert.deepEqual(ONBOARDING_CLIENT_OPTIONS.map((option) => option.value), ["chatgpt", "codex", "claude", "custom"]);
assert.equal(updateOnboardingSubagentsConfig(configured, []).enabled, false);
assert.equal(updateOnboardingSubagentsConfig(configured, []).providers[0]?.model, "gpt-5.4");
assert.match(clientConnectionInstructions("codex", "http://127.0.0.1:7676/mcp"), /codex mcp add flyto2-runtime --url 'http:\/\/127.0.0.1:7676\/mcp'/);
assert.match(clientConnectionInstructions("codex", "http://127.0.0.1:7676/mcp"), /codex mcp login/);
assert.match(clientConnectionInstructions("claude", "https://runtime.example/mcp"), /claude mcp add --transport http/);
assert.match(clientConnectionInstructions("chatgpt", "https://runtime.example/mcp"), /OAuth/);
assert.match(clientConnectionInstructions("chatgpt", "https://runtime.example/mcp"), /refresh or recreate/);
assert.match(clientConnectionInstructions("custom", "http://127.0.0.1:7676/mcp"), /Cloud is not required/);

{
  const { suggestedProjectRoots } = await import("./onboarding.js");
  const base = { homeDirectory: "/Users/me", runtimePackageRoot: "/Users/me/Flyto2 Runtime" };
  // Existing configuration always wins.
  assert.equal(suggestedProjectRoots({ ...base, configuredRoots: ["/a", "/b"], cwd: "/Users/me/Flyto2 Runtime" }), "/a, /b");
  // The launcher's own directory, anything inside it, and the whole home are never offered.
  assert.equal(suggestedProjectRoots({ ...base, configuredRoots: [], cwd: "/Users/me/Flyto2 Runtime" }), "");
  assert.equal(suggestedProjectRoots({ ...base, configuredRoots: [], cwd: "/Users/me/Flyto2 Runtime/dist" }), "");
  assert.equal(suggestedProjectRoots({ ...base, configuredRoots: [], cwd: "/Users/me" }), "");
  // A sibling that merely shares the prefix is a real project.
  assert.equal(suggestedProjectRoots({ ...base, configuredRoots: [], cwd: "/Users/me/Flyto2 Runtime Notes" }), "/Users/me/Flyto2 Runtime Notes");
  assert.equal(suggestedProjectRoots({ ...base, configuredRoots: [], cwd: "/Users/me/Projects/app" }), "/Users/me/Projects/app");
}
