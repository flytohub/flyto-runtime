import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import type { ServerConfig } from "../config.js";
import type { Flyto2CapabilityTransport } from "./capability-transport.js";
import { flyto2CapabilityInvocationSchema } from "./protocol.js";

export const LOCAL_CAPABILITY_BRIDGE_BASE_PATH = "/flyto2/capabilities/v1";
export const LOCAL_CAPABILITY_BRIDGE_TOKEN_HEADER = "x-flyto2-capability-token";
const TOKEN_FILE = "capability-bridge.token";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export type CapabilityBridgeActivityTracker = <T>(
  operation: () => Promise<T>,
) => Promise<T>;

/** Stable token-file location used by same-user cross-process consumers. */
export function localCapabilityBridgeTokenPath(stateDir: string): string {
  return join(stateDir, TOKEN_FILE);
}

/**
 * Returns the persistent same-user bridge token, creating a 0600 token file
 * when needed. The token is intentionally separate from MCP OAuth credentials.
 */
export function ensureLocalCapabilityBridgeToken(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const path = localCapabilityBridgeTokenPath(stateDir);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (!TOKEN_PATTERN.test(existing)) {
      throw new Error(`Invalid local capability bridge token at ${path}.`);
    }
    hardenTokenFile(path);
    return existing;
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  hardenTokenFile(path);
  return token;
}

/**
 * Registers the localhost-only cross-process execution bridge. It exposes only
 * the provider-neutral Runtime manifest and `flyto2.execution.v1` invocation.
 */
export function registerLocalCapabilityBridge(
  app: Express,
  config: Pick<ServerConfig, "stateDir">,
  transport: Flyto2CapabilityTransport,
  trackActivity: CapabilityBridgeActivityTracker = (operation) => operation(),
): void {
  const token = ensureLocalCapabilityBridgeToken(config.stateDir);

  app.get(`${LOCAL_CAPABILITY_BRIDGE_BASE_PATH}/manifest`, (req, res) => {
    if (!authorizeLocalBridge(req, res, token)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(transport.manifest());
  });

  app.post(`${LOCAL_CAPABILITY_BRIDGE_BASE_PATH}/invoke`, async (req, res) => {
    if (!authorizeLocalBridge(req, res, token)) return;
    const parsed = flyto2CapabilityInvocationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_capability_invocation" });
      return;
    }
    try {
      const result = await trackActivity(() => transport.invoke(parsed.data));
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    } catch {
      res.status(500).json({ error: "capability_bridge_failure" });
    }
  });
}

function authorizeLocalBridge(req: Request, res: Response, expectedToken: string): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
    res.status(403).json({ error: "local_capability_bridge_only" });
    return false;
  }
  const supplied = req.header(LOCAL_CAPABILITY_BRIDGE_TOKEN_HEADER) ?? "";
  if (!secureEqual(supplied, expectedToken)) {
    res.status(401).json({ error: "invalid_capability_bridge_token" });
    return false;
  }
  return true;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1"
    || address === "::1"
    || address.startsWith("::ffff:127.");
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hardenTokenFile(path: string): void {
  if (process.platform === "win32") return;
  chmodSync(path, 0o600);
}
