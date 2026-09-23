import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { win32 as winPath } from "node:path";
import { devspaceConfigDir } from "../user-config.js";
import { flyto2RuntimePackageRoot } from "./macos-launcher.js";

export interface InstalledWindowsLaunchers {
  directory: string;
  launchers: string[];
}

export function windowsDesktopRoot(
  homeDirectory = homedir(),
  currentPlatform: NodeJS.Platform = platform(),
): string {
  if (currentPlatform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetFolderPath('Desktop')",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const resolved = typeof result.stdout === "string"
      ? result.stdout.trim()
      : "";
    if (result.status === 0 && resolved) return resolved;
  }
  return winPath.join(homeDirectory, "Desktop");
}

export function renderWindowsDesktopLauncher(options: {
  packageRoot: string;
  configDirectory: string;
  nodePath: string;
  mode: "menu" | "start" | "doctor" | "setup";
}): string {
  const cliPath = winPath.join(options.packageRoot, "dist", "cli.js");
  const nodeDirectory = winPath.dirname(options.nodePath);
  const command = options.mode === "start"
    ? "service start"
    : options.mode === "setup"
      ? "init --force"
      : options.mode;

  return [
    "@echo off",
    "setlocal",
    `set "FLYTO2_RUNTIME_CONFIG_DIR=${escapeBatchValue(options.configDirectory)}"`,
    `set "DEVSPACE_CONFIG_DIR=${escapeBatchValue(options.configDirectory)}"`,
    `set "PATH=${escapeBatchValue(nodeDirectory)};%PATH%"`,
    `"${escapeBatchQuoted(options.nodePath)}" "${escapeBatchQuoted(cliPath)}" ${command}`,
    "if errorlevel 1 pause",
    "",
  ].join("\r\n");
}

export function installWindowsDesktopLaunchers(
  packageRoot = flyto2RuntimePackageRoot(),
  desktopRoot = windowsDesktopRoot(),
  configDirectory = devspaceConfigDir(),
  nodePath = process.execPath,
): InstalledWindowsLaunchers {
  if (platform() !== "win32") {
    throw new Error("Desktop .cmd launchers are supported on Windows only.");
  }

  const directory = winPath.join(desktopRoot, "Flyto2 Runtime");
  mkdirSync(directory, { recursive: true });
  const definitions = [
    ["Flyto2 Runtime.cmd", "menu"],
    ["Start Flyto2 Runtime.cmd", "start"],
    ["Doctor Flyto2 Runtime.cmd", "doctor"],
    ["Setup Flyto2 Runtime.cmd", "setup"],
  ] as const;

  const launchers: string[] = [];
  for (const [name, mode] of definitions) {
    const target = winPath.join(directory, name);
    writeFileSync(
      target,
      renderWindowsDesktopLauncher({
        packageRoot,
        configDirectory,
        nodePath,
        mode,
      }),
      "utf8",
    );
    launchers.push(target);
  }
  return { directory, launchers };
}

export function windowsDesktopLauncherStatus(
  desktopRoot = windowsDesktopRoot(),
): { directory: string; installed: boolean } {
  const directory = winPath.join(desktopRoot, "Flyto2 Runtime");
  return { directory, installed: existsSync(directory) };
}

export function removeWindowsDesktopLaunchers(
  desktopRoot = windowsDesktopRoot(),
): string {
  if (platform() !== "win32") {
    throw new Error("Desktop .cmd launchers are supported on Windows only.");
  }
  const directory = winPath.join(desktopRoot, "Flyto2 Runtime");
  rmSync(directory, { recursive: true, force: true });
  return directory;
}

function escapeBatchValue(value: string): string {
  // Percent expansion happens before SET parses the quoted form.
  return value.replaceAll("%", "%%");
}

function escapeBatchQuoted(value: string): string {
  return value.replaceAll("%", "%%").replaceAll('"', '""');
}
