import { platform } from "node:os";
import {
  installedMacRuntimeConfigDirectory,
  installMacRuntimeService,
  macRuntimeServiceStatus,
  restartMacRuntimeService,
  rollbackMacRuntimeService,
  startMacRuntimeService,
  stopMacRuntimeService,
  uninstallMacRuntimeService,
} from "./macos-service.js";
import {
  installedWindowsRuntimeConfigDirectory,
  installWindowsRuntimeService,
  restartWindowsRuntimeService,
  rollbackWindowsRuntimeService,
  startWindowsRuntimeService,
  stopWindowsRuntimeService,
  uninstallWindowsRuntimeService,
  windowsRuntimeServiceStatus,
} from "./windows-service.js";

export function nativeServiceSupported(): boolean {
  return platform() === "darwin" || platform() === "win32";
}

export function installedNativeRuntimeConfigDirectory(): string | undefined {
  switch (platform()) {
    case "darwin":
      return installedMacRuntimeConfigDirectory();
    case "win32":
      return installedWindowsRuntimeConfigDirectory();
    default:
      return undefined;
  }
}

export function installNativeRuntimeService(options: {
  packageRoot?: string;
  configDirectory?: string;
  start?: boolean;
} = {}) {
  switch (platform()) {
    case "darwin":
      return installMacRuntimeService(options);
    case "win32":
      return installWindowsRuntimeService(options);
    default:
      throw unsupported();
  }
}

export function startNativeRuntimeService(options: {
  packageRoot?: string;
  configDirectory?: string;
} = {}) {
  switch (platform()) {
    case "darwin":
      return startMacRuntimeService(options);
    case "win32":
      return startWindowsRuntimeService(options);
    default:
      throw unsupported();
  }
}

export function stopNativeRuntimeService(options: {
  packageRoot?: string;
  configDirectory?: string;
} = {}) {
  switch (platform()) {
    case "darwin":
      return stopMacRuntimeService(options);
    case "win32":
      return stopWindowsRuntimeService(options);
    default:
      throw unsupported();
  }
}

export function restartNativeRuntimeService(options: {
  packageRoot?: string;
  configDirectory?: string;
} = {}) {
  switch (platform()) {
    case "darwin":
      return restartMacRuntimeService(options);
    case "win32":
      return restartWindowsRuntimeService(options);
    default:
      throw unsupported();
  }
}

export function rollbackNativeRuntimeService(options: {
  packageRoot?: string;
  configDirectory?: string;
} = {}) {
  switch (platform()) {
    case "darwin":
      return rollbackMacRuntimeService(options);
    case "win32":
      return rollbackWindowsRuntimeService(options);
    default:
      throw unsupported();
  }
}

export function uninstallNativeRuntimeService(options: {
  packageRoot?: string;
  configDirectory?: string;
} = {}) {
  switch (platform()) {
    case "darwin":
      return uninstallMacRuntimeService(options);
    case "win32":
      return uninstallWindowsRuntimeService(options);
    default:
      throw unsupported();
  }
}

export function nativeRuntimeServiceStatus(options: {
  packageRoot?: string;
  configDirectory?: string;
} = {}) {
  switch (platform()) {
    case "darwin":
      return macRuntimeServiceStatus(options);
    case "win32":
      return windowsRuntimeServiceStatus(options);
    default:
      return {
        supported: false,
        label: "flyto2-runtime",
        installed: false,
        loaded: false,
        packageRoot: options.packageRoot ?? "",
        configDirectory: options.configDirectory ?? "",
      };
  }
}

function unsupported(): Error {
  return new Error(
    `Flyto2 Runtime background service management is not supported on ${platform()}.`,
  );
}
