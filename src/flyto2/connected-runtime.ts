import type {
  Flyto2Assignment,
  Flyto2RuntimeManifest,
} from "./protocol.js";
import type {
  Flyto2ClaimReceipt,
  Flyto2Completion,
  Flyto2Progress,
} from "./cloud-bridge.js";

export interface Flyto2CloudAssignmentTransport {
  waitForAssignment(signal?: AbortSignal): Promise<Flyto2Assignment | undefined>;
  claim(assignmentId: string, signal?: AbortSignal): Promise<Flyto2ClaimReceipt>;
  renewLease(
    assignmentId: string,
    leaseId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  reportProgress(
    assignmentId: string,
    leaseId: string,
    progress: Flyto2Progress,
    signal?: AbortSignal,
  ): Promise<{ cancel_requested: boolean }>;
  complete(
    assignmentId: string,
    leaseId: string,
    completion: Flyto2Completion,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface Flyto2AssignmentExecutionContext {
  readonly manifest: Flyto2RuntimeManifest;
  readonly leaseId: string;
  readonly signal?: AbortSignal;
  reportProgress(progress: Flyto2Progress): Promise<{ cancel_requested: boolean }>;
}

export interface Flyto2AssignmentExecutor {
  execute(
    assignment: Flyto2Assignment,
    context: Flyto2AssignmentExecutionContext,
  ): Promise<Flyto2Completion>;
}

export interface ConnectedFlyto2RuntimeOptions {
  leaseRenewIntervalMs?: number;
  onAssignmentError?: (
    assignment: Flyto2Assignment,
    error: unknown,
  ) => void | Promise<void>;
}

const DEFAULT_LEASE_RENEW_INTERVAL_MS = 45_000;

export class ConnectedFlyto2Runtime {
  private readonly leaseRenewIntervalMs: number;

  constructor(
    private readonly manifest: Flyto2RuntimeManifest,
    private readonly transport: Flyto2CloudAssignmentTransport,
    private readonly executor: Flyto2AssignmentExecutor,
    private readonly options: ConnectedFlyto2RuntimeOptions = {},
  ) {
    this.leaseRenewIntervalMs =
      options.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS;
    if (
      !Number.isFinite(this.leaseRenewIntervalMs)
      || this.leaseRenewIntervalMs <= 0
    ) {
      throw new Error("leaseRenewIntervalMs must be positive.");
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const assignment = await this.transport.waitForAssignment(signal);
      if (!assignment) continue;
      try {
        await this.executeAssignment(assignment, signal);
      } catch (error) {
        await this.options.onAssignmentError?.(assignment, error);
        if (signal?.aborted) return;
      }
    }
  }

  async executeAssignment(
    assignment: Flyto2Assignment,
    signal?: AbortSignal,
  ): Promise<void> {
    const claim = await this.transport.claim(assignment.assignment_id, signal);
    const leaseAbort = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, leaseAbort.signal])
      : leaseAbort.signal;
    const renewal = this.renewLeaseUntilStopped(
      assignment.assignment_id,
      claim.lease_id,
      leaseAbort.signal,
    );

    let completion: Flyto2Completion;
    try {
      completion = await this.executor.execute(assignment, {
        manifest: this.manifest,
        leaseId: claim.lease_id,
        signal: combinedSignal,
        reportProgress: (progress) =>
          this.transport.reportProgress(
            assignment.assignment_id,
            claim.lease_id,
            progress,
            combinedSignal,
          ),
      });
    } catch (error) {
      completion = {
        status: "failed",
        error_message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      leaseAbort.abort();
      await renewal;
    }

    await this.transport.complete(
      assignment.assignment_id,
      claim.lease_id,
      completion,
      signal,
    );
  }

  private async renewLeaseUntilStopped(
    assignmentId: string,
    leaseId: string,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await abortableDelay(this.leaseRenewIntervalMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (signal.aborted) return;
      await this.transport.renewLease(assignmentId, leaseId, signal);
    }
  }
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
