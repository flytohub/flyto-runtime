/**
 * Explicitly enabled, separate HTTPS listener for a locally paired phone.
 *
 * It does not expose the Runtime's same-user localhost bridge token or MCP
 * authority. Capabilities come exclusively from the installed Runtime
 * provider registry. Physical/explicit-approval operations fail closed.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server as HttpsServer } from "node:https";
import { once } from "node:events";
import express, { type Express, type Request, type Response } from "express";
import type { ServerConfig } from "../config.js";
import type { RuntimeCapabilityRegistry } from "./capability-provider.js";
import { registryCapabilityTransport, type Flyto2CapabilityTransport } from "./capability-transport.js";
import { flyto2CapabilityInvocationSchema, flyto2CapabilityResultSchema } from "./protocol.js";

export const MOBILE_COMPANION_BASE = "/flyto2/mobile/v1";
const PAIR_LIFETIME_MS = 120_000;
const SESSION_LIFETIME_MS = 30 * 60_000;
const MAX_PAIR_ATTEMPTS = 5;
const ALLOW_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const SAFE_HOST_PATTERN = /^[a-zA-Z0-9.:-]+$/;

type PairedSession = { digest: Buffer; expires: number };
type Replay = { fingerprint: string; result: Promise<unknown>; expires: number };

const digest = (value: string) => createHash("sha256").update(value).digest();
const equal = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export interface MobileGatewayOptions {
  transport: Flyto2CapabilityTransport;
  allowedCapabilities: ReadonlySet<string>;
  pairingCode?: string; // Injection for tests. Generated for the real listener.
  now?: () => number;
}

/** The API cannot gain authority from input params or from the App. */
export function createMobileCompanionGateway(options: MobileGatewayOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb", strict: true }));
  const now = options.now ?? Date.now;
  const code = options.pairingCode ?? randomInt(0, 100_000_000).toString().padStart(8, "0");
  if (!/^\d{8}$/.test(code)) throw new Error("Invalid pairing code");
  const created = now();
  let attempts = 0;
  let used = false;
  const sessions = new Map<string, PairedSession>();
  const replays = new Map<string, Replay>();

  function authorized(req: Request, res: Response): string | undefined {
    const auth = req.header("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{40,128})$/.exec(auth);
    if (!match) {
      res.status(401).json({ error: "mobile_session_required" });
      return undefined;
    }
    const fingerprint = digest(match[1]);
    for (const [key, session] of sessions) {
      if (session.expires <= now()) {
        sessions.delete(key);
      } else if (equal(session.digest, fingerprint)) {
        return key;
      }
    }
    res.status(401).json({ error: "mobile_session_expired" });
    return undefined;
  }

  app.post(MOBILE_COMPANION_BASE + "/pair", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const input = req.body?.code;
    if (used || attempts >= MAX_PAIR_ATTEMPTS || now() - created > PAIR_LIFETIME_MS) {
      res.status(403).json({ error: "pairing_unavailable" });
      return;
    }
    attempts += 1;
    if (typeof input !== "string" || !/^\d{8}$/.test(input) ||
        !equal(digest(input), digest(code))) {
      res.status(403).json({ error: "invalid_pairing_code" });
      return;
    }
    used = true;
    const token = randomBytes(32).toString("base64url");
    sessions.set("paired-device", { digest: digest(token), expires: now() + SESSION_LIFETIME_MS });
    res.json({
      schema: "flyto2.mobile-pairing.v1",
      access_token: token,
      expires_in_seconds: SESSION_LIFETIME_MS / 1000,
    });
  });

  app.get(MOBILE_COMPANION_BASE + "/manifest", (req, res) => {
    if (!authorized(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    const manifest = options.transport.manifest();
    res.json({
      ...manifest,
      capabilities: manifest.capabilities.filter((c) =>
        options.allowedCapabilities.has(c.id) &&
        c.risk_level !== "dangerous" &&
        c.risk_level !== "high" &&
        c.approval !== "explicit"
      ),
      mobile_gateway_schema: "flyto2.mobile-companion.v1",
    });
  });

  app.post(MOBILE_COMPANION_BASE + "/invoke", async (req, res) => {
    const sessionId = authorized(req, res);
    if (!sessionId) return;
    const parsed = flyto2CapabilityInvocationSchema.safeParse(req.body);
    if (!parsed.success || JSON.stringify(req.body).length > 12_000) {
      res.status(400).json({ error: "invalid_invocation" });
      return;
    }
    const command = parsed.data;
    const capability = options.transport.manifest().capabilities.find(c =>
      c.id === command.capability && c.revision === command.revision);
    if (!capability || !options.allowedCapabilities.has(capability.id) ||
        capability.risk_level === "high" || capability.risk_level === "dangerous" ||
        capability.approval === "explicit") {
      res.status(403).json({ error: "capability_not_authorized" });
      return;
    }
    // No ambiguous side effects on reconnect: identical operation IDs only
    // replay the original result; a changed payload is a conflict.
    const key = sessionId + ":" + command.operation_id;
    const fingerprint = digest(JSON.stringify(command)).toString("hex");
    const prior = replays.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        res.status(409).json({ error: "operation_id_reuse" });
        return;
      }
      try {
        res.setHeader("Cache-Control", "no-store");
        res.json(await prior.result);
      } catch {
        res.status(502).json({ error: "invocation_failed_check_state_before_retry" });
      }
      return;
    }
    if (replays.size >= 1024) {
      res.status(503).json({ error: "idempotency_store_full" });
      return;
    }
    const result = options.transport.invoke(command)
      .then(x => flyto2CapabilityResultSchema.parse(x));
    replays.set(key, { fingerprint, result, expires: now() + SESSION_LIFETIME_MS });
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await result);
    } catch {
      res.status(502).json({ error: "invocation_failed_check_state_before_retry" });
    }
    for (const [id, entry] of replays) if (entry.expires <= now()) replays.delete(id);
  });

  // One session per server lifetime in this first secure handoff. No remote
  // session refresh and no anonymous pairing-code retrieval endpoint.
  app.post(MOBILE_COMPANION_BASE + "/unpair", (req, res) => {
    const id = authorized(req, res);
    if (!id) return;
    sessions.delete(id);
    res.setHeader("Cache-Control", "no-store");
    res.json({ revoked: true });
  });
  return app;
}

export type MobileGatewayHandle = {
  server: HttpsServer;
  pairingCode: string;
  certificateSha256: string;
  close(): Promise<void>;
};

/** No HTTP or insecure default: TLS files and allowlist must be explicitly set. */
export async function startMobileCompanionGateway(
  config: ServerConfig,
  registry: RuntimeCapabilityRegistry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MobileGatewayHandle | null> {
  if (env.FLYTO2_MOBILE_ENABLE !== "1") return null;
  const host = env.FLYTO2_MOBILE_HOST ?? "";
  const port = Number(env.FLYTO2_MOBILE_PORT ?? "0");
  const certPath = env.FLYTO2_MOBILE_TLS_CERT ?? "";
  const keyPath = env.FLYTO2_MOBILE_TLS_KEY ?? "";
  const allowed = (env.FLYTO2_MOBILE_CAPABILITIES ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!host || !SAFE_HOST_PATTERN.test(host) ||
      !Number.isInteger(port) || port < 1024 || port > 65535 ||
      !certPath || !keyPath || allowed.length === 0 ||
      !allowed.every(s => ALLOW_PATTERN.test(s))) {
    throw new Error("Mobile gateway requires explicit host, port, TLS certificate/key, and capability allowlist");
  }
  const pairingCode = randomInt(0, 100_000_000).toString().padStart(8, "0");
  const app = createMobileCompanionGateway({
    transport: registryCapabilityTransport(config, registry),
    allowedCapabilities: new Set(allowed),
    pairingCode,
  });
  const certificate = readFileSync(certPath);
  const certificateSha256 = new X509Certificate(certificate)
    .fingerprint256.replaceAll(":", "").toLowerCase();
  const server = createServer({
    cert: certificate,
    key: readFileSync(keyPath),
    minVersion: "TLSv1.2",
  }, app);
  server.listen(port, host);
  await once(server, "listening");
  return {
    server,
    pairingCode,
    certificateSha256,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(err => err ? reject(err) : resolve()));
    },
  };
}
