export interface RestartTunnelReadiness {
  configured: boolean;
  connector_count: number;
  ready_connectors: number;
}

export interface RestartReadinessOptions {
  publicBaseUrl: string;
  tunnelReadiness: () => Promise<RestartTunnelReadiness>;
  fetchImpl?: typeof fetch;
  attempts?: number;
  intervalMs?: number;
  requiredConsecutiveSuccesses?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function waitForRestartReadiness(
  options: RestartReadinessOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? 40;
  const intervalMs = options.intervalMs ?? 250;
  const requiredConsecutiveSuccesses = options.requiredConsecutiveSuccesses ?? 2;
  const sleep = options.sleep ?? ((milliseconds) => (
    new Promise((resolve) => setTimeout(resolve, milliseconds))
  ));
  const healthUrl = new URL("/healthz", options.publicBaseUrl).toString();
  const mcpUrl = new URL("/mcp", options.publicBaseUrl).toString();
  let consecutive = 0;
  let lastDetail = "not checked";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const tunnel = await options.tunnelReadiness();
    const tunnelReady = !tunnel.configured
      || (
        tunnel.connector_count > 0
        && tunnel.ready_connectors === tunnel.connector_count
      );

    const healthReady = await probeRuntimeHealth(healthUrl, fetchImpl);
    const mcpReady = healthReady && await probeMcpRoute(mcpUrl, fetchImpl);

    if (tunnelReady && healthReady && mcpReady) {
      consecutive += 1;
      if (consecutive >= requiredConsecutiveSuccesses) return;
    } else {
      consecutive = 0;
      lastDetail = [
        tunnel.configured
          ? `tunnel ${tunnel.ready_connectors}/${tunnel.connector_count}`
          : "tunnel not configured",
        `public health ${healthReady ? "ok" : "unreachable"}`,
        `public MCP ${mcpReady ? "reachable" : "unreachable"}`,
      ].join(", ");
    }

    if (attempt < attempts) await sleep(intervalMs);
  }

  throw new Error(
    `Flyto2 Runtime restarted locally but public MCP recovery did not stabilize: ${lastDetail}.`,
  );
}

async function probeRuntimeHealth(
  url: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown; name?: unknown };
    return body.ok === true && body.name === "flyto2-runtime";
  } catch {
    return false;
  }
}

async function probeMcpRoute(
  url: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "restart-readiness",
        method: "ping",
      }),
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });

    // An unauthenticated readiness probe is expected to be rejected by OAuth.
    // Any bounded non-5xx response proves the public edge reaches Runtime's MCP
    // route rather than a stale tunnel/origin failure.
    return response.status >= 200 && response.status < 500 && response.status !== 404;
  } catch {
    return false;
  }
}
