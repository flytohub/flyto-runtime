/** Pure watchdog decisions; retries are bounded even when the network stays down. */
export interface TunnelRepairState {
  attempts: number;
  nextRetryAt: number;
  dnsUnavailable: boolean;
}

export const INITIAL_TUNNEL_REPAIR_STATE: Readonly<TunnelRepairState> = {
  attempts: 0,
  nextRetryAt: 0,
  dnsUnavailable: false,
};

export const TUNNEL_DNS_RECHECK_MS = 60_000;
export const TUNNEL_MAX_REPAIR_BACKOFF_MS = 300_000;

export type TunnelRepairDecision = {
  action: "healthy" | "wait" | "dns_unavailable" | "repair";
  state: TunnelRepairState;
  dnsTransition: "lost" | "restored" | undefined;
  retryMs?: number;
};

/** Call with `dnsAvailable=false` only if every connector is down and edge DNS failed. */
export function decideTunnelRepair(
  previous: Readonly<TunnelRepairState>,
  now: number,
  degraded: boolean,
  dnsAvailable = true,
): TunnelRepairDecision {
  if (!degraded) {
    return {
      action: "healthy",
      state: { ...INITIAL_TUNNEL_REPAIR_STATE },
      dnsTransition: previous.dnsUnavailable ? "restored" : undefined,
    };
  }

  if (now < previous.nextRetryAt) {
    return { action: "wait", state: { ...previous }, dnsTransition: undefined };
  }

  if (!dnsAvailable) {
    return {
      action: "dns_unavailable",
      state: { ...previous, nextRetryAt: now + TUNNEL_DNS_RECHECK_MS, dnsUnavailable: true },
      dnsTransition: previous.dnsUnavailable ? undefined : "lost",
      retryMs: TUNNEL_DNS_RECHECK_MS,
    };
  }

  const attempts = previous.attempts + 1;
  const retryMs = Math.min(
    TUNNEL_MAX_REPAIR_BACKOFF_MS,
    2_000 * (2 ** Math.min(attempts - 1, 8)),
  );
  return {
    action: "repair",
    state: { attempts, nextRetryAt: now + retryMs, dnsUnavailable: false },
    dnsTransition: previous.dnsUnavailable ? "restored" : undefined,
    retryMs,
  };
}
