import { homedir, platform } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { flyto2RuntimePackageRoot } from "./macos-launcher.js";

export const RESTART_LAUNCH_AGENT_LABEL = "local.flyto2.runtime.restart";
export const RESTART_WINDOWS_TASK = "Flyto2 Runtime Restart";

export interface RestartJobSpec {
  nodePath: string;
  cliPath: string;
  packageRoot: string;
  configDirectory: string;
  pathEnvironment: string;
}

export function currentRestartJobSpec(configDirectory: string): RestartJobSpec {
  const packageRoot = flyto2RuntimePackageRoot();
  return {
    nodePath: process.execPath,
    cliPath: join(packageRoot, "dist", "cli.js"),
    packageRoot,
    configDirectory,
    pathEnvironment: [dirname(process.execPath), process.env.PATH]
      .filter(Boolean)
      .join(platform() === "win32" ? ";" : ":"),
  };
}

export function restartWorkerArguments(configDirectory: string): string[] {
  return ["service", "restart-worker", configDirectory];
}

export async function scheduleNativeRestart(
  spec: RestartJobSpec,
): Promise<{ scheduled: true; worker: string }> {
  switch (platform()) {
    case "darwin": {
      const { startMacOneShotAgent } = await import("./macos-service.js");
      startMacOneShotAgent({
        label: RESTART_LAUNCH_AGENT_LABEL,
        plistPath: posix.join(
          homedir(),
          "Library",
          "LaunchAgents",
          `${RESTART_LAUNCH_AGENT_LABEL}.plist`,
        ),
        programArguments: [
          spec.nodePath,
          spec.cliPath,
          ...restartWorkerArguments(spec.configDirectory),
        ],
        environment: {
          FLYTO2_RUNTIME_CONFIG_DIR: spec.configDirectory,
          DEVSPACE_CONFIG_DIR: spec.configDirectory,
          PATH: spec.pathEnvironment,
        },
        logPath: posix.join(
          homedir(),
          "Library",
          "Logs",
          "Flyto2 Runtime",
          "restart.log",
        ),
      });
      return { scheduled: true, worker: RESTART_LAUNCH_AGENT_LABEL };
    }
    case "win32": {
      const { startWindowsOneShotTask } = await import("./windows-service.js");
      const root = win32.join(
        process.env.LOCALAPPDATA ?? homedir(),
        "Flyto2 Runtime",
        "restart",
      );
      startWindowsOneShotTask({
        taskName: RESTART_WINDOWS_TASK,
        xmlPath: win32.join(root, "restart-task.xml"),
        command: spec.nodePath,
        arguments: [spec.cliPath, ...restartWorkerArguments(spec.configDirectory)],
        workingDirectory: spec.packageRoot,
      });
      return { scheduled: true, worker: RESTART_WINDOWS_TASK };
    }
    default:
      throw new Error(
        "Managed Runtime restart scheduling is available on macOS and Windows only.",
      );
  }
}
