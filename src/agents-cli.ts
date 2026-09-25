import type { Result as BetterResult } from "better-result";
import { loadConfig } from "./config.js";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
} from "./local-agent-catalog.js";
import { loadLocalAgentProfiles } from "./local-agent-profiles.js";
import {
  parseLocalAgentContinueArgs,
  parseLocalAgentRunArgs,
} from "./local-agent-targets.js";
import { createLocalAgentClient } from "./local-agent-client.js";
import { toAgentErrorPayload, type LocalAgentError } from "./local-agent-errors.js";
import {
  formatAgentCommandError,
  formatAgentObservation,
  formatAgentReceipt,
  formatAgentSummary,
  formatAgentTargetCatalog,
  presentAgentObservation,
  presentAgentReceipt,
  presentAgentSummary,
  presentAgentTargetCatalog,
} from "./local-agent-presentation.js";

export async function runAgentsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const { args: commandArgs, json } = extractJsonOption(rest);
  switch (subcommand) {
    case "ls":
    case "list":
      await runAgentWorkflowCommand(json, () => runAgentsList(commandArgs, json));
      return;
    case "run":
      await runAgentWorkflowCommand(json, () => runAgentsRun(commandArgs, json));
      return;
    case "continue":
      await runAgentWorkflowCommand(json, () => runAgentsContinue(commandArgs, json));
      return;
    case "show":
      await runAgentWorkflowCommand(json, () => runAgentsShow(commandArgs, json));
      return;
    case "wait":
      await runAgentWorkflowCommand(json, () => runAgentsWait(commandArgs, json));
      return;
    case "targets":
      await runAgentWorkflowCommand(json, () => runAgentsTargets(commandArgs, json));
      return;
    case "daemon":
      await runAgentsDaemon(commandArgs, json);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentsHelp();
      return;
    default:
      writeAgentWorkflowError(`Unknown agents command: ${subcommand}`, json);
  }
}

async function runAgentsTargets(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: devspace agents targets [--json]");
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const profiles = await loadLocalAgentProfiles(config, scope.workspaceRoot);
  const providers = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
  );
  const catalog = buildLocalAgentCatalog(config.subagents, profiles, providers);
  const output = presentAgentTargetCatalog(catalog);
  if (json) printJson(output);
  else printAgentXml(formatAgentTargetCatalog(output));
}

async function runAgentsList(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) throw new Error("Usage: devspace agents ls [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const result = await client.list(resolveCliWorkspaceContext(config.allowedRoots));
  const agents = presentAgentWorkflowResult(result, json);
  if (!agents) return;

  const summaries = agents.map(presentAgentSummary);
  if (json) {
    printJson(summaries);
    return;
  }

  printAgentXml(summaries.map(formatAgentSummary).join("\n"));
}

async function runAgentsRun(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentRunArgs(args);
  const config = loadConfig();
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const client = createLocalAgentClient(config);
  const result = await client.start({
    target: parsed.target,
    prompt: parsed.prompt,
    workspaceRoot: scope.workspaceRoot,
    workspaceId: scope.workspaceId,
    model: parsed.model,
    effort: parsed.effort,
  });
  const record = presentAgentWorkflowResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  printAgentXml(formatAgentReceipt(receipt));
}

async function runAgentsContinue(args: string[], json: boolean): Promise<void> {
  const parsed = parseLocalAgentContinueArgs(args);
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const result = await client.continue(parsed.agentId, parsed.prompt, {
    model: parsed.model,
    effort: parsed.effort,
  }, scope);
  const record = presentAgentWorkflowResult(result, json);
  if (!record) return;
  const receipt = presentAgentReceipt(record);
  if (json) {
    printJson(receipt);
    return;
  }
  printAgentXml(formatAgentReceipt(receipt));
}

async function runAgentsShow(args: string[], json: boolean): Promise<void> {
  const [id, ...extra] = args;
  if (!id || extra.length > 0) throw new Error("Usage: devspace agents show <id> [--json]");

  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const initial = await client.get(id, scope);
  const record = presentAgentWorkflowResult(initial, json);
  if (!record) return;

  const observation = presentAgentObservation(record);
  if (json) printJson(observation);
  else printAgentXml(formatAgentObservation(observation));
}

async function runAgentsWait(args: string[], json: boolean): Promise<void> {
  const { ids, timeoutMs } = parseAgentsWaitArgs(args);
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  const scope = resolveCliWorkspaceContext(config.allowedRoots);
  const results = presentAgentWorkflowResult(await client.wait(ids, scope, timeoutMs), json);
  if (!results) return;
  if (json) {
    printJson(results);
    return;
  }
  printAgentXml(results.map(formatAgentObservation).join("\n"));
}

function parseAgentsWaitArgs(args: string[]): { ids: string[]; timeoutMs?: number } {
  const ids: string[] = [];
  let timeoutMs: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--timeout") {
      timeoutMs = parseAgentWaitTimeout(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("--timeout=")) {
      timeoutMs = parseAgentWaitTimeout(argument.slice("--timeout=".length));
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}.`);
    ids.push(argument);
  }
  if (ids.length === 0) {
    throw new Error("Usage: devspace agents wait <id>... [--timeout <seconds>] [--json]");
  }
  return { ids, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function parseAgentWaitTimeout(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error("Agent wait timeout must be a non-negative integer number of seconds.");
  }
  const timeoutMs = Number(value) * 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647) {
    throw new Error("Agent wait timeout is too large.");
  }
  return timeoutMs;
}

async function runAgentsDaemon(args: string[], json: boolean): Promise<void> {
  const [subcommand, ...extra] = args;
  if (extra.length > 0) throw new Error("Usage: devspace agents daemon <status|stop|logs> [--json]");
  const config = loadConfig();
  const client = createLocalAgentClient(config);
  switch (subcommand) {
    case "status": {
      const status = presentAgentResult(await client.status(), json);
      if (!status) return;
      printJson(status);
      return;
    }
    case "stop": {
      const status = presentAgentResult(await client.stop(), json);
      if (!status) return;
      if (json) printJson(status);
      else console.log("Local agent daemon stop requested.");
      return;
    }
    case "logs": {
      const logs = presentAgentResult(await client.logs(), json);
      if (logs === undefined) return;
      if (json) printJson({ logs });
      else console.log(logs || "No local agent daemon logs found.");
      return;
    }
    default:
      throw new Error("Usage: devspace agents daemon <status|stop|logs>");
  }
}

function extractJsonOption(args: string[]): { args: string[]; json: boolean } {
  const commandArgs: string[] = [];
  let json = false;
  let optionsEnded = false;
  for (const argument of args) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      commandArgs.push(argument);
      continue;
    }
    if (!optionsEnded && argument === "--json") {
      json = true;
      continue;
    }
    commandArgs.push(argument);
  }
  return { args: commandArgs, json };
}

function presentAgentResult<T, E extends LocalAgentError>(
  result: BetterResult<T, E>,
  json: boolean,
): T | undefined {
  if (result.isOk()) return result.value;
  if (json) {
    printJson({ error: toAgentErrorPayload(result.error) });
    process.exitCode = 1;
    return undefined;
  }
  throw new Error(result.error.message);
}

function presentAgentWorkflowResult<T, E extends LocalAgentError>(
  result: BetterResult<T, E>,
  json: boolean,
): T | undefined {
  if (result.isOk()) return result.value;
  const error = toAgentErrorPayload(result.error);
  if (json) printJson({ error });
  else console.error(formatAgentCommandError(error));
  process.exitCode = 1;
  return undefined;
}

async function runAgentWorkflowCommand(json: boolean, command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    writeAgentWorkflowError(error instanceof Error ? error.message : String(error), json);
  }
}

function writeAgentWorkflowError(message: string, json: boolean): void {
  const error = { code: "AGENT_COMMAND_ERROR", message, retryable: false };
  if (json) printJson({ error });
  else console.error(formatAgentCommandError(error));
  process.exitCode = 1;
}

function printAgentXml(fragment: string): void {
  if (fragment) console.log(fragment);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function printAgentsHelp(): void {
  console.log(
    [
      "DevSpace agents",
      "",
      "Usage:",
      "  devspace agents ls [--json]",
      "  devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  devspace agents continue <id> [--model <model>] [--effort <level>] [--json] <prompt>",
      "  devspace agents show <id> [--json]",
      "  devspace agents wait <id>... [--timeout <seconds>] [--json]",
      "  devspace agents targets [--json]",
      "  devspace agents daemon <status|stop|logs> [--json]",
    ].join("\n"),
  );
}

