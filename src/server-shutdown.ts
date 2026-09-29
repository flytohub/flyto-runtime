export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
  closeAllConnections?(): void;
}

export interface ShutdownHttpServerResult {
  forced: boolean;
  http_closed: boolean;
  application_closed: boolean;
}

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
  timeoutMs = 5_000,
): Promise<ShutdownHttpServerResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("shutdown timeout must be a positive number");
  }

  let httpDone = false;
  let applicationDone = false;
  let httpError: Error | undefined;
  let applicationError: unknown;

  const httpClosed = new Promise<void>((resolve) => {
    try {
      httpServer.close((error) => {
        httpDone = true;
        httpError = error;
        resolve();
      });
    } catch (error) {
      httpDone = true;
      httpError = error instanceof Error ? error : new Error(String(error));
      resolve();
    }
  });
  const applicationClosed = Promise.resolve()
    .then(closeApplication)
    .then(
      () => {
        applicationDone = true;
      },
      (error) => {
        applicationDone = true;
        applicationError = error;
      },
    );
  const allClosed = Promise.all([httpClosed, applicationClosed]);

  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    allClosed.then(() => "closed" as const),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (outcome === "timeout") {
    try {
      httpServer.closeAllConnections?.();
    } catch {
      // The caller is already on the forced shutdown path.
    }
    await Promise.resolve();
  }

  if (httpError) throw httpError;
  if (applicationError) throw applicationError;

  return {
    forced: outcome === "timeout",
    http_closed: httpDone,
    application_closed: applicationDone,
  };
}
