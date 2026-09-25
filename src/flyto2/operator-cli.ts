import { loadDevspaceFiles, setDevspaceConfigValues } from "../user-config.js";

export async function runServiceCommand(args: string[]): Promise<void> {
  const [subcommand = "status", ...rest] = args;
  if (subcommand === "restart-worker") {
    await runRestartWorker(rest);
    return;
  }
  if (
    subcommand === "restart"
    && rest.length === 0
    && process.env.FLYTO2_RUNTIME_MANAGED_SERVICE === "1"
  ) {
    await scheduleManagedRestart();
    return;
  }
  if (subcommand === "self-update") {
    await runSelfUpdateCommand(rest);
    return;
  }
  if (subcommand === "quick-tunnel") {
    await runQuickTunnelCommand(rest);
    return;
  }

  const { runNativeServiceCommand } = await import("./service-cli.js");
  await runNativeServiceCommand(subcommand, rest);
}

export async function runLauncherCommand(args: string[]): Promise<void> {
  const [subcommand = "status", ...rest] = args;
  if (rest.length > 0) {
    throw new Error("Usage: flyto2-runtime launcher <install|status|remove>");
  }

  const launcher = process.platform === "win32"
    ? await import("./windows-launcher.js")
    : await import("./macos-launcher.js");

  switch (subcommand) {
    case "install": {
      const installed = process.platform === "win32"
        ? (launcher as typeof import("./windows-launcher.js")).installWindowsDesktopLaunchers()
        : (launcher as typeof import("./macos-launcher.js")).installMacDesktopLaunchers();
      console.log(JSON.stringify({ ok: true, ...installed }, null, 2));
      return;
    }
    case "status": {
      const status = process.platform === "win32"
        ? (launcher as typeof import("./windows-launcher.js")).windowsDesktopLauncherStatus()
        : (launcher as typeof import("./macos-launcher.js")).macDesktopLauncherStatus();
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    case "remove": {
      const directory = process.platform === "win32"
        ? (launcher as typeof import("./windows-launcher.js")).removeWindowsDesktopLaunchers()
        : (launcher as typeof import("./macos-launcher.js")).removeMacDesktopLaunchers();
      console.log(JSON.stringify({ ok: true, removed: directory }, null, 2));
      return;
    }
    default:
      throw new Error("Usage: flyto2-runtime launcher <install|status|remove>");
  }
}

async function scheduleManagedRestart(): Promise<void> {
  const service = await import("./native-service.js");
  if (!service.nativeRuntimeServiceStatus().installed) {
    throw new Error(
      "Managed Runtime restart needs the background service to be installed.",
    );
  }
  const configDirectory = service.installedNativeRuntimeConfigDirectory()
    ?? loadDevspaceFiles().dir;
  const scheduler = await import("./restart-scheduler.js");
  const scheduled = await scheduler.scheduleNativeRestart(
    scheduler.currentRestartJobSpec(configDirectory),
  );
  console.log(JSON.stringify({
    ...scheduled,
    next: "The Runtime will restart after this MCP response is released. Reconnect to the same MCP URL; task and workspace state remain local and persistent.",
  }, null, 2));
}

async function runRestartWorker(args: string[]): Promise<void> {
  const [configDirectory, ...extra] = args;
  if (!configDirectory || extra.length > 0) {
    throw new Error("Invalid Runtime restart worker invocation.");
  }

  process.env.FLYTO2_RUNTIME_CONFIG_DIR = configDirectory;
  process.env.DEVSPACE_CONFIG_DIR = configDirectory;

  // Give the originating MCP response time to leave the old Runtime before the
  // one-shot OS worker terminates it.
  await new Promise((resolve) => setTimeout(resolve, 900));

  const { runNativeServiceCommand } = await import("./service-cli.js");
  await runNativeServiceCommand("restart", []);

  const tunnel = await import("./native-tunnel.js");
  const { loadConfig } = await import("../config.js");
  const { waitForRestartReadiness } = await import("./restart-readiness.js");
  const config = loadConfig({
    ...process.env,
    FLYTO2_RUNTIME_CONFIG_DIR: configDirectory,
    DEVSPACE_CONFIG_DIR: configDirectory,
  });
  await waitForRestartReadiness({
    publicBaseUrl: config.publicBaseUrl,
    tunnelReadiness: () => tunnel.nativeTunnelReadiness(),
  });
}

async function runQuickTunnelCommand(args: string[]): Promise<void> {
  const quick = await import("./quick-tunnel-service.js");
  const [action = "status", ...extra] = args;
  if (extra.length > 0) throw new Error("Usage: flyto2-runtime service quick-tunnel [start|stop|status]");
  switch (action) {
    case "start": {
      const status = await startQuickTunnelForConfig(quick);
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    case "stop":
      console.log(JSON.stringify(await quick.stopQuickTunnel(), null, 2));
      return;
    case "status":
      console.log(JSON.stringify(await quick.quickTunnelStatus(), null, 2));
      return;
    default:
      throw new Error("Usage: flyto2-runtime service quick-tunnel [start|stop|status]");
  }
}

async function startQuickTunnelForConfig(
  quick: typeof import("./quick-tunnel-service.js"),
): Promise<Awaited<ReturnType<typeof quick.startQuickTunnel>>> {
  const source = quick.cloudflaredSource();
  if (source.kind === "unsupported") {
    throw new Error("Automatic quick tunnels need macOS or Windows on a supported processor.");
  }
  const binaryPath = source.kind === "installed" ? source.path : await quick.provideCloudflared(source);
  const files = loadDevspaceFiles();
  const status = await quick.startQuickTunnel({ binaryPath, originPort: files.config.server.port });
  setDevspaceConfigValues([{ path: ["server", "publicBaseUrl"], value: status.public_base_url }]);
  return status;
}

// This command only schedules an OS-owned job, so it can safely be invoked
// through the Runtime without keeping the current HTTP request alive.
async function runSelfUpdateCommand(args: string[]): Promise<void> {
  const selfUpdate = await import("./self-update.js");
  const { flyto2NativeRuntimeHome } = await import("./native-paths.js");
  const { flyto2BuildInfo } = await import("./build-info.js");
  const paths = selfUpdate.selfUpdatePaths(flyto2NativeRuntimeHome());
  const [action, requestId, ...extra] = args;
  const usage = "Usage: flyto2-runtime service self-update [status]";
  const { packagedDistribution, FLYTO2_RUNTIME_DOWNLOADS_URL } = await import("./distribution.js");
  if (action !== "status" && packagedDistribution()) {
    throw new Error(`This Runtime was installed from the Flyto2 Runtime app, which updates by installing the new version from ${FLYTO2_RUNTIME_DOWNLOADS_URL}.`);
  }

  if (action === undefined) {
    const service = await import("./native-service.js");
    if (!service.nativeRuntimeServiceStatus().installed) {
      throw new Error(
        "Remote self-update switches the background service, which is not installed. Run `flyto2-runtime service install` first.",
      );
    }
    const scheduler = await import("./self-update-scheduler.js");
    const configDirectory = service.installedNativeRuntimeConfigDirectory()
      ?? loadDevspaceFiles().dir;
    const status = selfUpdate.scheduleSelfUpdate(paths, await scheduler.nativeSelfUpdateScheduler(paths, {
      ...scheduler.currentSelfUpdateJobSpec(),
      configDirectory,
    }));
    console.log(JSON.stringify({
      ...status,
      current_sha: flyto2BuildInfo().git_sha,
      next: "The update runs in the background: fetch main, require green CI, build, restart behind a health check, roll back on failure. "
        + "The connection drops for a few seconds during the restart. Check progress with `flyto2-runtime service self-update status`.",
    }, null, 2));
    return;
  }
  if (action === "status" && requestId === undefined) {
    console.log(JSON.stringify({
      current_sha: flyto2BuildInfo().git_sha,
      update: selfUpdate.readSelfUpdateStatus(paths) ?? null,
    }, null, 2));
    return;
  }
  if (action === "run" && requestId && extra.length === 0) {
    const { spawnSync } = await import("node:child_process");
    const service = await import("./native-service.js");
    const status = await selfUpdate.runSelfUpdate(requestId, paths, {
      run: (command, commandArgs, options) => {
        const result = spawnSync(command, commandArgs, {
          cwd: options?.cwd,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          shell: process.platform === "win32" && command.endsWith(".cmd"),
          windowsHide: true,
        });
        return {
          status: result.status,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? (result.error ? String(result.error) : ""),
        };
      },
      fetchCheckRuns: (sha) => selfUpdate.fetchCheckRuns(sha),
      currentGitSha: () => flyto2BuildInfo().git_sha,
      activate: (packageRoot) => {
        service.installNativeRuntimeService({
          packageRoot,
          configDirectory: loadDevspaceFiles().dir,
          start: true,
        });
      },
      pnpm: (await import("./pnpm-command.js")).resolvePnpm(),
    });
    console.log(JSON.stringify(status, null, 2));
    if (status.phase === "failed" || status.phase === "rolled_back") process.exitCode = 1;
    return;
  }
  throw new Error(usage);
}
