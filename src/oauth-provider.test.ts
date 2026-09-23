import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OAUTH_REFRESH_RETRY_GRACE_SECONDS,
  SingleUserOAuthProvider,
} from "./oauth-provider.js";
import { SqliteOAuthStore } from "./oauth-store.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

test("refresh rotation keeps the consumed token valid only for bounded response-loss retry", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "flyto2-oauth-retry-"));

  const resource = "https://runtime.example.test/mcp";
  const originalRefreshToken = "original-refresh-token";
  const now = Math.floor(Date.now() / 1000);

  const seed = new SqliteOAuthStore(stateDir);
  const client = seed.registerClient({
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  }, ["chatgpt.com"]);
  seed.saveRefreshToken(hashToken(originalRefreshToken), {
    clientId: client.client_id,
    scopes: ["devspace"],
    expiresAt: now + 30 * 24 * 60 * 60,
    resource,
  });
  seed.close();

  const provider = new SingleUserOAuthProvider({
    ownerToken: "owner-token",
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
    scopes: ["devspace"],
    allowedResourceUrls: [],
    allowedRedirectHosts: ["chatgpt.com"],
  }, new URL(resource), stateDir);
  t.after(async () => {
    provider.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const first = await provider.exchangeRefreshToken(
    client,
    originalRefreshToken,
    undefined,
    new URL(resource),
  );
  assert.ok(first.access_token);
  assert.ok(first.refresh_token);
  assert.notEqual(first.refresh_token, originalRefreshToken);

  const inspectAfterFirst = new SqliteOAuthStore(stateDir);
  const retryRecord = inspectAfterFirst.getRefreshToken(hashToken(originalRefreshToken));
  inspectAfterFirst.close();
  assert.ok(retryRecord);
  assert.ok(
    retryRecord.expiresAt <= Math.floor(Date.now() / 1000) + OAUTH_REFRESH_RETRY_GRACE_SECONDS,
  );

  const retryExpiry = retryRecord.expiresAt;
  const second = await provider.exchangeRefreshToken(
    client,
    originalRefreshToken,
    undefined,
    new URL(resource),
  );
  assert.ok(second.access_token);
  assert.ok(second.refresh_token);

  const inspectAfterRetry = new SqliteOAuthStore(stateDir);
  const retryRecordAfterReplay = inspectAfterRetry.getRefreshToken(hashToken(originalRefreshToken));
  inspectAfterRetry.close();
  assert.ok(retryRecordAfterReplay);
  assert.equal(
    retryRecordAfterReplay.expiresAt,
    retryExpiry,
    "retrying a lost response must not extend the old token replay window",
  );
});
