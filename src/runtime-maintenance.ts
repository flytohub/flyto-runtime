import type { ServerConfig } from "./config.js";
import { logEvent } from "./logger.js";
import { pruneStaleManagedWorktrees } from "./worktree-prune.js";
import {
  startNativeTunnelWatchdog,
  startQuickTunnelFollower,
} from "./flyto2/tunnel-supervision.js";

const MANAGED_WORKTREE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface RuntimeMaintenance {
  start(): void;
  stop(): void;
}

export function createRuntimeMaintenance(config: ServerConfig): RuntimeMaintenance {
  let running = false;
  let started = false;
  let stopped = false;
  let initial: NodeJS.Immediate | undefined;
  let interval: NodeJS.Timeout | undefined;
  let stopTunnelWatchdog = () => {};
  let stopQuickTunnelFollower = () => {};

  const run = () => {
    if (running || stopped) return;
    running = true;
    void runManagedWorktreeCleanup(config).finally(() => {
      running = false;
    });
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      // Maintenance starts only after the HTTP listener is ready. Git cleanup
      // must never delay health checks or service recovery.
      stopTunnelWatchdog = startNativeTunnelWatchdog(config, true);
      stopQuickTunnelFollower = startQuickTunnelFollower(config, true);
      initial = setImmediate(run);
      initial.unref();
      interval = setInterval(run, MANAGED_WORKTREE_CLEANUP_INTERVAL_MS);
      interval.unref();
    },
    stop() {
      stopped = true;
      if (initial) clearImmediate(initial);
      if (interval) clearInterval(interval);
      stopTunnelWatchdog();
      stopQuickTunnelFollower();
    },
  };
}

async function runManagedWorktreeCleanup(config: ServerConfig): Promise<void> {
  try {
    const cleanup = await pruneStaleManagedWorktrees(config);
    if (cleanup.isErr()) {
      logEvent(config.logging, "warn", "managed_worktree_cleanup_failed", {
        error: cleanup.error.message,
        operation: cleanup.error.operation,
      });
      return;
    }

    const result = cleanup.value;
    const preserved = result.removed.filter((entry) => entry.recoveryRef).length;
    if (result.removed.length > 0 || result.missing.length > 0 || result.skipped.length > 0) {
      logEvent(config.logging, "info", "managed_worktree_cleanup", {
        removed: result.removed.length,
        recoveryRefs: preserved,
        missingSessions: result.missing.length,
        skippedUntracked: result.skipped.length,
      });
    }
    for (const failure of result.failed) {
      logEvent(config.logging, "warn", "managed_worktree_cleanup_failed", {
        workspaceId: failure.workspaceId,
        error: failure.error.message,
        operation: failure.error.operation,
      });
    }
  } catch (error) {
    logEvent(config.logging, "warn", "managed_worktree_cleanup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
