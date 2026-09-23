import { homedir, platform } from "node:os";
import { posix, win32 } from "node:path";

export function flyto2NativeRuntimeHome(
  homeDirectory = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  currentPlatform: NodeJS.Platform = platform(),
): string {
  switch (currentPlatform) {
    case "darwin":
      return posix.join(
        homeDirectory,
        "Library",
        "Application Support",
        "Flyto2 Runtime",
      );
    case "win32": {
      const localAppData = env.LOCALAPPDATA?.trim();
      return localAppData
        ? win32.join(localAppData, "Flyto2 Runtime")
        : win32.join(homeDirectory, "AppData", "Local", "Flyto2 Runtime");
    }
    default: {
      const dataHome = env.XDG_DATA_HOME?.trim();
      return dataHome
        ? posix.join(dataHome, "flyto2-runtime")
        : posix.join(homeDirectory, ".local", "share", "flyto2-runtime");
    }
  }
}
