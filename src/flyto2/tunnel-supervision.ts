import { spawn } from "node:child_process";
import { Resolver } from "node:dns/promises";
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
import {
  decideTunnelRepair,
  INITIAL_TUNNEL_REPAIR_STATE,
} from "./tunnel-repair-policy.js";

// A quick tunnel's URL changes whenever cloudflared restarts. The saved public
// URL decides which Host headers and OAuth resource this process accepts, so a
// stale one locks every client out. Save the live URL and exit; the service
// manager restarts this process with it (a non-zero code, because the Windows
// supervisor treats exit 0 as a deliberate stop).
const QUICK_TUNNEL_RESTART_EXIT_CODE = 75;
// This is cloudflared's edge-discovery SRV name (not a DNS server override).
const CLOUDFLARE_EDGE_SRV = "_v2-origintunneld._tcp.argotunnel.com";

async function cloudflareEdgeDnsAvailable(): Promise<boolean> {
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  try {
    return (await resolver.resolveSrv(CLOUDFLARE_EDGE_SRV)).length > 0;
  } catch {
    return false;
  }
}

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
  let repairState = { ...INITIAL_TUNNEL_REPAIR_STATE };

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const readiness = await nativeTunnelReadiness();
      const now = Date.now();
      const degraded = shouldRepairNativeTunnelRedundancy(readiness);
      if (degraded && now < repairState.nextRetryAt) return;
      // Do not churn launchd/cloudflared during an upstream DNS outage.
      // When at least one connector works, repair only the degraded peer.
      const dnsAvailable = !degraded || readiness.ready_connectors > 0
        || await cloudflareEdgeDnsAvailable();
      if (stopped) return;
      const decision = decideTunnelRepair(repairState, now, degraded, dnsAvailable);
      repairState = decision.state;
      if (decision.dnsTransition) {
        logEvent(config.logging, decision.dnsTransition === "lost" ? "warn" : "info",
          decision.dnsTransition === "lost" ? "tunnel_edge_dns_unavailable" : "tunnel_edge_dns_restored", {
            readyConnectors: readiness.ready_connectors,
            connectorCount: readiness.connector_count,
            nextRetryMs: decision.retryMs,
          });
      }
      if (decision.action !== "repair") return;
      const cliPath = process.argv[1];
      if (!cliPath) return;

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
      child.once("error", (error) => {
        logEvent(config.logging, "warn", "tunnel_repair_spawn_failed", {
          error: error.message,
        });
      });
      child.unref();

      logEvent(config.logging, "warn", "tunnel_repair_started", {
        readyConnectors: readiness.ready_connectors,
        connectorCount: readiness.connector_count,
        repairAttempt: repairState.attempts,
        nextRetryMs: decision.retryMs,
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
