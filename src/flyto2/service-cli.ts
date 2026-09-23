import { loadDevspaceFiles } from "../user-config.js";

type NativeServiceModule = typeof import("./native-service.js");
type NativeTunnelModule = typeof import("./native-tunnel.js");

const SERVICE_USAGE =
  "Usage: flyto2-runtime service <stage|install|start|stop|restart|status|update|self-update [status]|quick-tunnel [start|stop|status]|rollback|uninstall|legacy-status|disable-legacy-updater|restore-legacy|tunnel-import|tunnel-migrate|tunnel-start|tunnel-stop|tunnel-status>";
const TUNNEL_IMPORT_USAGE =
  "Usage: flyto2-runtime service tunnel-import <config-path> [--cloudflared <path>] [--hostname <host>]";

export async function runNativeServiceCommand(
  subcommand: string,
  rest: string[],
): Promise<void> {
  if (subcommand !== "tunnel-import" && rest.length > 0) {
    throw new Error(SERVICE_USAGE);
  }

  const [service, tunnel] = await Promise.all([
    import("./native-service.js"),
    import("./native-tunnel.js"),
  ]);

  if (subcommand === "stage") {
    await stageNativeServices(service, tunnel);
    return;
  }
  if (subcommand === "update") {
    await stageLatestRelease(service);
    return;
  }
  if (isLegacyCommand(subcommand)) {
    await runLegacyCommand(subcommand);
    return;
  }
  if (subcommand.startsWith("tunnel-")) {
    await runTunnelCommand(subcommand, rest, tunnel);
    return;
  }

  await runLifecycleCommand(subcommand, service, tunnel);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function startTunnelIfConfigured(tunnel: NativeTunnelModule) {
  return tunnel.loadNativeTunnelProfile()
    ? tunnel.startNativeTunnelService()
    : tunnel.nativeTunnelStatus();
}

function stopTunnelIfConfigured(tunnel: NativeTunnelModule) {
  return tunnel.loadNativeTunnelProfile()
    ? tunnel.stopNativeTunnelService()
    : tunnel.nativeTunnelStatus();
}

async function stageNativeServices(
  service: NativeServiceModule,
  tunnel: NativeTunnelModule,
): Promise<void> {
  const configDirectory = loadDevspaceFiles().dir;
  let profile = tunnel.loadNativeTunnelProfile();

  if (!profile && process.platform === "darwin") {
    try {
      profile = tunnel.migrateLegacyCloudflareTunnel(configDirectory);
    } catch {
      // Tunnel configuration is optional. Stage the Runtime even when no
      // legacy Cloudflare profile exists.
    }
  }

  const tunnelStatus = profile
    ? tunnel.installNativeTunnelService(false)
    : tunnel.nativeTunnelStatus();
  const runtime = service.installNativeRuntimeService({
    configDirectory,
    start: false,
  });
  const legacy = process.platform === "darwin"
    ? (await import("./macos-service.js")).legacyMacKitStatus()
    : undefined;

  printJson({
    runtime,
    tunnel: tunnelStatus,
    ...(profile ? { tunnel_profile: profile } : {}),
    ...(legacy ? { legacy } : {}),
  });
}

async function stageLatestRelease(
  service: NativeServiceModule,
): Promise<void> {
  const updater = await import("./github-release-updater.js");
  const release = await updater.installLatestFlyto2Release();
  const runtime = service.installNativeRuntimeService({
    packageRoot: release.package_root,
    configDirectory: loadDevspaceFiles().dir,
    start: false,
  });

  printJson({
    runtime,
    release,
    update_source: "https://github.com/flytohub/flyto-runtime/releases/latest",
    staged: true,
    activation_command: "flyto2-runtime service restart",
  });
}

async function runLifecycleCommand(
  subcommand: string,
  service: NativeServiceModule,
  tunnel: NativeTunnelModule,
): Promise<void> {
  switch (subcommand) {
    case "install": {
      const runtime = service.installNativeRuntimeService();
      const nativeTunnel = startTunnelIfConfigured(tunnel);
      printJson({ runtime, tunnel: nativeTunnel });
      return;
    }
    case "start": {
      const runtime = service.startNativeRuntimeService();
      const nativeTunnel = startTunnelIfConfigured(tunnel);
      printJson({ runtime, tunnel: nativeTunnel });
      return;
    }
    case "stop": {
      const nativeTunnel = stopTunnelIfConfigured(tunnel);
      const runtime = service.stopNativeRuntimeService();
      printJson({ runtime, tunnel: nativeTunnel });
      return;
    }
    case "restart": {
      const runtime = service.restartNativeRuntimeService();
      const nativeTunnel = startTunnelIfConfigured(tunnel);
      printJson({ runtime, tunnel: nativeTunnel });
      return;
    }
    case "status":
      await printServiceStatus(service, tunnel);
      return;
    case "rollback":
      printJson(service.rollbackNativeRuntimeService());
      return;
    case "uninstall": {
      const nativeTunnel = stopTunnelIfConfigured(tunnel);
      const runtime = service.uninstallNativeRuntimeService();
      printJson({ runtime, tunnel: nativeTunnel });
      return;
    }
    default:
      throw new Error(SERVICE_USAGE);
  }
}

async function printServiceStatus(
  service: NativeServiceModule,
  tunnel: NativeTunnelModule,
): Promise<void> {
  const legacy = process.platform === "darwin"
    ? (await import("./macos-service.js")).legacyMacKitStatus()
    : undefined;
  printJson({
    runtime: service.nativeRuntimeServiceStatus(),
    tunnel: tunnel.nativeTunnelStatus(),
    ...(legacy ? { legacy } : {}),
  });
}

function isLegacyCommand(subcommand: string): boolean {
  return subcommand === "legacy-status"
    || subcommand === "disable-legacy-updater"
    || subcommand === "restore-legacy";
}

async function runLegacyCommand(subcommand: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Legacy Mac Kit commands are available on macOS only.");
  }
  const legacy = await import("./macos-service.js");
  switch (subcommand) {
    case "legacy-status":
      printJson(legacy.legacyMacKitStatus());
      return;
    case "disable-legacy-updater":
      printJson(legacy.stopLegacyMacKitUpdater());
      return;
    case "restore-legacy":
      printJson(legacy.restoreLegacyMacKit());
      return;
    default:
      throw new Error(SERVICE_USAGE);
  }
}

async function runTunnelCommand(
  subcommand: string,
  rest: string[],
  tunnel: NativeTunnelModule,
): Promise<void> {
  switch (subcommand) {
    case "tunnel-import":
      runTunnelImport(rest, tunnel);
      return;
    case "tunnel-migrate":
      runTunnelMigration(tunnel);
      return;
    case "tunnel-start":
      printJson(tunnel.startNativeTunnelService());
      return;
    case "tunnel-stop":
      printJson(tunnel.stopNativeTunnelService());
      return;
    case "tunnel-status":
      printJson(tunnel.nativeTunnelStatus());
      return;
    default:
      throw new Error(SERVICE_USAGE);
  }
}

function runTunnelImport(
  args: string[],
  tunnel: NativeTunnelModule,
): void {
  const configPath = args[0];
  if (!configPath) throw new Error(TUNNEL_IMPORT_USAGE);

  const options = parseTunnelImportOptions(args.slice(1));
  const profile = tunnel.importCloudflareTunnel({
    configPath,
    ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
    ...(options.hostname ? { hostname: options.hostname } : {}),
  });
  const status = tunnel.installNativeTunnelService(false);
  printJson({ profile, status });
}

function parseTunnelImportOptions(args: string[]): {
  binaryPath?: string;
  hostname?: string;
} {
  let binaryPath: string | undefined;
  let hostname: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--cloudflared" && value) {
      binaryPath = value;
      index += 1;
      continue;
    }
    if (flag === "--hostname" && value) {
      hostname = value;
      index += 1;
      continue;
    }
    throw new Error(TUNNEL_IMPORT_USAGE);
  }

  return { binaryPath, hostname };
}

function runTunnelMigration(tunnel: NativeTunnelModule): void {
  if (process.platform !== "darwin") {
    throw new Error("Legacy tunnel migration is available on macOS only.");
  }
  const profile = tunnel.migrateLegacyCloudflareTunnel(
    loadDevspaceFiles().dir,
  );
  const status = tunnel.installNativeTunnelService(false);
  printJson({ profile, status });
}
