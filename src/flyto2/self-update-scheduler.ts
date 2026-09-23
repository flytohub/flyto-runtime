import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { devspaceConfigDir } from "../user-config.js";
import { flyto2RuntimePackageRoot } from "./macos-launcher.js";
import type { SelfUpdatePaths, SelfUpdateScheduler } from "./self-update.js";

export const SELF_UPDATE_LAUNCH_AGENT_LABEL = "local.flyto2.runtime.updater";
export const SELF_UPDATE_WINDOWS_TASK = "Flyto2 Runtime Updater";

export interface SelfUpdateJobSpec {
  nodePath: string;
  cliPath: string;
  configDirectory: string;
  pathEnvironment: string;
}

export function currentSelfUpdateJobSpec(): SelfUpdateJobSpec {
  return {
    nodePath: process.execPath,
    cliPath: join(flyto2RuntimePackageRoot(), "dist", "cli.js"),
    configDirectory: devspaceConfigDir(),
    // git and pnpm must resolve inside the job exactly as they do here.
    pathEnvironment: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(platform() === "win32" ? ";" : ":"),
  };
}

export function selfUpdateRunArguments(requestId: string): string[] {
  return ["service", "self-update", "run", requestId];
}

export function renderWindowsSelfUpdateScript(spec: SelfUpdateJobSpec, requestId: string): string {
  const literal = (value: string) => value.replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$env:FLYTO2_RUNTIME_CONFIG_DIR = '${literal(spec.configDirectory)}'`,
    `$env:DEVSPACE_CONFIG_DIR = '${literal(spec.configDirectory)}'`,
    `$env:PATH = '${literal(spec.pathEnvironment)}'`,
    `& '${literal(spec.nodePath)}' '${literal(spec.cliPath)}' ${selfUpdateRunArguments(requestId).map((arg) => `'${literal(arg)}'`).join(" ")}`,
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n");
}

export async function nativeSelfUpdateScheduler(
  paths: SelfUpdatePaths,
  spec: SelfUpdateJobSpec = currentSelfUpdateJobSpec(),
): Promise<SelfUpdateScheduler> {
  switch (platform()) {
    case "darwin": {
      const { startMacOneShotAgent } = await import("./macos-service.js");
      return (requestId) => startMacOneShotAgent({
        label: SELF_UPDATE_LAUNCH_AGENT_LABEL,
        plistPath: posix.join(homedir(), "Library", "LaunchAgents", `${SELF_UPDATE_LAUNCH_AGENT_LABEL}.plist`),
        programArguments: [spec.nodePath, spec.cliPath, ...selfUpdateRunArguments(requestId)],
        environment: {
          FLYTO2_RUNTIME_CONFIG_DIR: spec.configDirectory,
          DEVSPACE_CONFIG_DIR: spec.configDirectory,
          PATH: spec.pathEnvironment,
        },
        logPath: paths.logPath,
      });
    }
    case "win32": {
      const { startWindowsOneShotTask } = await import("./windows-service.js");
      return (requestId) => {
        const scriptPath = win32.join(paths.root, "run-self-update.ps1");
        mkdirSync(paths.root, { recursive: true });
        writeFileSync(scriptPath, renderWindowsSelfUpdateScript(spec, requestId), "utf8");
        startWindowsOneShotTask({
          taskName: SELF_UPDATE_WINDOWS_TASK,
          xmlPath: win32.join(paths.root, "self-update-task.xml"),
          command: "powershell.exe",
          arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
          workingDirectory: paths.root,
        });
      };
    }
    default:
      throw new Error(
        "Remote self-update needs the macOS or Windows background service. On Linux, update the checkout and restart `flyto2-runtime serve`.",
      );
  }
}
