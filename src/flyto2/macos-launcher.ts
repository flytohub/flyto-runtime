import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { devspaceConfigDir } from "../user-config.js";
import { fileURLToPath } from "node:url";

export interface InstalledMacLaunchers {
  directory: string;
  launchers: string[];
}

export function flyto2RuntimePackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

export function installMacDesktopLaunchers(
  packageRoot = flyto2RuntimePackageRoot(),
  desktopRoot = join(homedir(), "Desktop"),
  configDirectory = devspaceConfigDir(),
): InstalledMacLaunchers {
  if (platform() !== "darwin") {
    throw new Error("Desktop .command launchers are supported on macOS only.");
  }

  const sourceLauncher = join(packageRoot, "Flyto2 Runtime.command");
  if (!existsSync(sourceLauncher)) {
    throw new Error(`Missing Flyto2 Runtime.command in ${packageRoot}`);
  }

  const directory = join(desktopRoot, "Flyto2 Runtime");
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const definitions = [
    ["Flyto2 Runtime.command", "menu"],
    ["Start Flyto2 Runtime.command", "start"],
    ["Doctor Flyto2 Runtime.command", "doctor"],
    ["Setup Flyto2 Runtime.command", "setup"],
  ] as const;

  const launchers: string[] = [];
  for (const [name, mode] of definitions) {
    const target = join(directory, name);
    writeFileSync(
      target,
      [
        "#!/bin/bash",
        "set -u",
        `export PATH=${shellQuote(dirname(process.execPath))}:"$PATH"`,
        `export DEVSPACE_CONFIG_DIR=${shellQuote(configDirectory)}`,
        `exec ${shellQuote(sourceLauncher)} ${shellQuote(mode)}`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    chmodSync(target, 0o700);
    launchers.push(target);
  }

  return { directory, launchers };
}

export function removeMacDesktopLaunchers(
  desktopRoot = join(homedir(), "Desktop"),
): string {
  if (platform() !== "darwin") {
    throw new Error("Desktop .command launchers are supported on macOS only.");
  }
  const directory = join(desktopRoot, "Flyto2 Runtime");
  rmSync(directory, { recursive: true, force: true });
  return directory;
}

export function macDesktopLauncherStatus(
  desktopRoot = join(homedir(), "Desktop"),
): {
  directory: string;
  installed: boolean;
} {
  const directory = join(desktopRoot, "Flyto2 Runtime");
  return { directory, installed: existsSync(directory) };
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
