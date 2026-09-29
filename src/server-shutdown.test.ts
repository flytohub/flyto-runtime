import assert from "node:assert/strict";
import { shutdownHttpServer } from "./server-shutdown.js";

let finishHttpClose: (() => void) | undefined;
let applicationCloseStarted = false;

const drainingHttpServer = {
  close(callback: (error?: Error) => void) {
    finishHttpClose = () => callback();
  },
};

const drainingShutdown = shutdownHttpServer(drainingHttpServer, async () => {
  applicationCloseStarted = true;
  assert.ok(
    finishHttpClose,
    "HTTP draining must start before application cleanup",
  );
  finishHttpClose();
});

await Promise.resolve();
assert.equal(
  applicationCloseStarted,
  true,
  "application cleanup must start while the HTTP server is draining",
);
await drainingShutdown;

let finishApplicationClose: (() => void) | undefined;
let shutdownResolved = false;

const immediatelyClosedHttpServer = {
  close(callback: (error?: Error) => void) {
    callback();
  },
};

const delayedApplicationClose = () =>
  new Promise<void>((resolve) => {
    finishApplicationClose = resolve;
  });

const delayedShutdown = shutdownHttpServer(
  immediatelyClosedHttpServer,
  delayedApplicationClose,
);
void delayedShutdown.then(() => {
  shutdownResolved = true;
});

await Promise.resolve();
assert.equal(
  shutdownResolved,
  false,
  "shutdown must wait for asynchronous application cleanup",
);
finishApplicationClose?.();
await delayedShutdown;
assert.equal(shutdownResolved, true);

let finishDelayedHttpClose: (() => void) | undefined;
let httpDrainResolved = false;
const delayedHttpDrain = shutdownHttpServer(
  {
    close(callback: (error?: Error) => void) {
      finishDelayedHttpClose = () => callback();
    },
  },
  async () => {},
);
void delayedHttpDrain.then(() => {
  httpDrainResolved = true;
});

await Promise.resolve();
assert.equal(
  httpDrainResolved,
  false,
  "shutdown must wait for active HTTP responses to drain",
);
finishDelayedHttpClose?.();
await delayedHttpDrain;
assert.equal(httpDrainResolved, true);

const httpCloseError = new Error("http close failed");
await assert.rejects(
  shutdownHttpServer(
    {
      close(callback: (error?: Error) => void) {
        callback(httpCloseError);
      },
    },
    async () => {},
  ),
  httpCloseError,
);

let forcedHttpCloseCalled = false;
const forcedStartedAt = performance.now();
const forced = await shutdownHttpServer(
  {
    close() {
      // Simulate an HTTP connection that never drains on its own.
    },
    closeAllConnections() {
      forcedHttpCloseCalled = true;
    },
  },
  () => new Promise<void>(() => {
    // Simulate a tool/application cleanup promise that never settles.
  }),
  25,
);
assert.equal(forced.forced, true);
assert.equal(forcedHttpCloseCalled, true);
assert.equal(forced.http_closed, false);
assert.equal(forced.application_closed, false);
assert.ok(
  performance.now() - forcedStartedAt < 500,
  "bounded shutdown must return instead of waiting forever",
);
