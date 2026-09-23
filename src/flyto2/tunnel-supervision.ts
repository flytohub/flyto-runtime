import { spawn } from "node:child_process";
import type { ServerConfig } from "../config.js";
import { logEvent } from "../logger.js";
import { setDevspaceConfigValues } from "../user-config.js";
import { flyto2NativeRuntimeHome } from "./native-paths.js";
import {
  nativeTunnelManagementSupported,
  nativeTunnelReadiness,
  shouldRepairNativeTunnelRedundancy,
} from "./native-tunnel.js";
import {
  fetchQuickTunnelHostname,
  quickTunnelUrlChange,
  readQuickTunnelProfile,
  waitForPublicDns,
} from "./quick-tunnel.js";

// A quick tunnel's URL changes whenever cloudflared restarts. The saved public
// URL decides which Host headers and OAuth resource this process accepts, so a
// stale one locks every client out. Save the live URL and exit; the service
// manager restarts this process with it (a non-zero code, because the Windows
// supervisor treats exit 0 as a deliberate stop).
const QUICK_TUNNEL_RESTART_EXIT_CODE = 75;

/** Follow quick-tunnel hostname rotation and restart managed Runtime services safely. */
export function startQuickTunnelFollower(
  config: ServerConfig,
  enabled: boolean,
): () => void {
  if (!enabled) return () => {};

  let stopped = false;
  let checking = false;

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const profile = readQuickTunnelProfile(flyto2NativeRuntimeHome());
      if (stopped || !profile) return;

      const liveHostname = await fetchQuickTunnelHostname(profile.metrics_port);
      const next = quickTunnelUrlChange(config.publicBaseUrl, liveHostname);
      if (stopped || !next || !liveHostname) return;

      await waitForPublicDns(liveHostname);
      if (stopped) return;

      setDevspaceConfigValues([{ path: ["server", "publicBaseUrl"], value: next }]);
      logEvent(config.logging, "warn", "quick_tunnel_url_changed", {
        from: config.publicBaseUrl,
        to: next,
      });

      if (process.env.FLYTO2_RUNTIME_MANAGED_SERVICE === "1") {
        process.exit(QUICK_TUNNEL_RESTART_EXIT_CODE);
      }
    } finally {
      checking = false;
    }
  };

  const interval = setInterval(() => void check().catch(() => {}), 10_000);
  interval.unref();

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/** Keep native tunnel redundancy healthy without putting tunnel lifecycle in the MCP server. */
export function startNativeTunnelWatchdog(
  config: ServerConfig,
  enabled: boolean,
): () => void {
  if (!enabled || !nativeTunnelManagementSupported()) return () => {};

  let stopped = false;
  let checking = false;
  let repairAttempt = 0;
  let nextRepairAt = 0;

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const readiness = await nativeTunnelReadiness();
      if (!shouldRepairNativeTunnelRedundancy(readiness)) {
        repairAttempt = 0;
        nextRepairAt = 0;
        return;
      }

      const now = Date.now();
      if (now < nextRepairAt) return;
      const cliPath = process.argv[1];
      if (!cliPath) return;

      const backoffMs = Math.min(30_000, 2_000 * (2 ** Math.min(repairAttempt, 4)));
      nextRepairAt = now + backoffMs;
      repairAttempt += 1;

      const child = spawn(
        process.execPath,
        [cliPath, "service", "tunnel-start"],
        {
          detached: true,
          stdio: "ignore",
          env: process.env,
          windowsHide: true,
        },
      );
      child.unref();

      logEvent(config.logging, "warn", "tunnel_repair_started", {
        readyConnectors: readiness.ready_connectors,
        connectorCount: readiness.connector_count,
        repairAttempt,
        nextRetryMs: backoffMs,
      });
    } catch (error) {
      logEvent(config.logging, "warn", "tunnel_watchdog_check_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      checking = false;
    }
  };

  const initial = setTimeout(() => void check(), 750);
  const interval = setInterval(() => void check(), 5_000);
  initial.unref();
  interval.unref();

  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}
