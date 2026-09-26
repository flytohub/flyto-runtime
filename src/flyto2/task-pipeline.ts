import type { HostTaskRecord, HostTaskStore } from "./host-tasks.js";
import type {
  ReactiveCommandRunner,
  ReactiveJobRecord,
} from "./reactive-command.js";

type PipelineHostTasks = Pick<
  HostTaskStore,
  "get" | "updatePlan" | "complete" | "listActiveWithPlans" | "findActiveByJobId"
>;

type PipelineReactiveCommands = Pick<
  ReactiveCommandRunner,
  "start" | "get" | "onTerminal"
>;

export class TaskPipelineRunner {
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly hostTasks: PipelineHostTasks,
    private readonly reactiveCommands: PipelineReactiveCommands,
  ) {
    this.unsubscribe = reactiveCommands.onTerminal((job) => {
      this.handleTerminal(job);
    });
    queueMicrotask(() => this.reconcile());
  }

  start(taskId: string): HostTaskRecord | undefined {
    const task = this.hostTasks.get(taskId);
    if (!task || task.status !== "active" || !task.plan) return task;
    if (task.plan.autoRun !== true) return task;
    return this.advance(task);
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
  }

  private reconcile(): void {
    if (this.closed) return;
    for (const task of this.hostTasks.listActiveWithPlans()) {
      const activeJobId = task.plan?.activeJobId;
      if (activeJobId) {
        const job = this.reactiveCommands.get(activeJobId);
        if (!job) {
          this.blockTask(
            task,
            "Runtime lost the active pipeline job reference; ChatGPT must inspect state before retrying.",
          );
          continue;
        }
        if (job.status === "running") continue;
        this.handleTerminal(job);
        continue;
      }
      this.advance(task);
    }
  }

  private advance(task: HostTaskRecord): HostTaskRecord | undefined {
    if (this.closed || task.status !== "active" || !task.plan) return task;
    const plan = task.plan;
    if (plan.autoRun !== true) return task;
    const stage = plan.stages[plan.currentStage - 1];
    if (!stage) return task;
    if (stage.status === "blocked") return task;

    if (stage.status === "done") {
      if (plan.currentStage >= plan.stages.length) {
        return this.hostTasks.complete(task.id, "Automated deterministic plan completed.");
      }
      const moved = this.hostTasks.updatePlan(task.id, {
        currentStage: plan.currentStage + 1,
        stageStatus: "running",
        activeJobId: null,
      });
      return moved ? this.advance(moved) : moved;
    }

    if (plan.activeJobId) return task;
    if (!stage.command) {
      return this.hostTasks.updatePlan(task.id, {
        currentStage: plan.currentStage,
        stageStatus: "running",
        activeJobId: null,
      });
    }

    try {
      const receipt = this.reactiveCommands.start({
        workspace_id: task.workspaceId,
        workspace_root: task.workspaceRoot,
        command: stage.command,
        cwd: task.workspaceRoot,
        event_type: "task.stage.exited",
        timeout_seconds: stage.timeoutSeconds,
      });
      return this.hostTasks.updatePlan(task.id, {
        currentStage: plan.currentStage,
        stageStatus: "running",
        stageSummary: stage.summary,
        activeJobId: receipt.job_id,
        evidenceRef: receipt.evidence_ref,
      });
    } catch (error) {
      return this.blockTask(
        task,
        `Pipeline stage could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleTerminal(job: ReactiveJobRecord): void {
    if (this.closed || job.status === "running") return;
    const task = this.hostTasks.findActiveByJobId(job.job_id);
    if (!task?.plan) return;

    const evidenceRef = job.evidence_ref;
    if (job.status !== "completed" || job.exit_code !== 0) {
      const detail = job.status === "orphaned"
        ? "Runtime restarted while this deterministic stage was running; outcome is uncertain, so it will not be retried automatically."
        : `Deterministic stage failed${job.exit_code === undefined ? "" : ` with exit code ${job.exit_code}`}.`;
      this.hostTasks.updatePlan(task.id, {
        currentStage: task.plan.currentStage,
        stageStatus: "blocked",
        stageSummary: detail,
        activeJobId: null,
        evidenceRef,
      });
      return;
    }

    const completed = this.hostTasks.updatePlan(task.id, {
      currentStage: task.plan.currentStage,
      stageStatus: "done",
      stageSummary: "Completed automatically by Flyto2 Runtime.",
      activeJobId: null,
      evidenceRef,
    });
    if (completed) this.advance(completed);
  }

  private blockTask(task: HostTaskRecord, summary: string): HostTaskRecord | undefined {
    if (!task.plan) return task;
    return this.hostTasks.updatePlan(task.id, {
      currentStage: task.plan.currentStage,
      stageStatus: "blocked",
      stageSummary: summary,
      activeJobId: null,
    });
  }
}
