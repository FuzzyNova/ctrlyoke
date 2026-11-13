import * as fs from "fs";
import type {
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../../types/CtrlYokeTypes";
import { WORKFLOW_LOCK_LIVENESS } from "../../types/DashboardConstants";
import { nextScheduleOccurrence } from "../../utils/WorkflowSchedule";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { readWorkflowLockInspection } from "../../utils/WorkflowLockInspector";
import { Log } from "../../utils/Log";
import type { WorkflowLineageRepository } from "./WorkflowLineageRepository";

const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;

export interface WorkflowSchedulerTimerApi {
  setTimeout(
    callback: () => void,
    delayMs: number
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface WorkflowSchedulerOptions {
  lineageRepository: WorkflowLineageRepository;
  workspaceRoot: string;
  now: () => number;
  timers: WorkflowSchedulerTimerApi;
  getHostId: () => string;
  isLineageRunning: (workflowKey: WorkflowKey) => Promise<boolean> | boolean;
  fire: (workflowKey: WorkflowKey) => Promise<void>;
}

/** Orchestrator-owned timers for lineage schedules. */
export class WorkflowScheduler {
  private readonly timersByWorkflow = new Map<
    WorkflowKey,
    ReturnType<typeof setTimeout>
  >();
  private disposed = false;

  constructor(private readonly options: WorkflowSchedulerOptions) {}

  async start(): Promise<void> {
    try {
      const keys = await this.options.lineageRepository.listLineageKeys(
        this.options.workspaceRoot
      );
      for (const key of keys) {
        try {
          await this.armFromDescriptor(
            key,
            await this.options.lineageRepository.readDescriptor(
              this.options.workspaceRoot,
              key
            )
          );
        } catch (error) {
          Log.error(
            `[WorkflowScheduler] Failed to load schedule for ${key}:`,
            error
          );
        }
      }
    } catch (error) {
      Log.error(
        "[WorkflowScheduler] Failed to enumerate scheduled workflows:",
        error
      );
    }
  }

  async refresh(workflowKey: WorkflowKey): Promise<void> {
    this.clearTimer(workflowKey);
    try {
      const descriptor = await this.options.lineageRepository.readDescriptor(
        this.options.workspaceRoot,
        workflowKey
      );
      await this.armFromDescriptor(workflowKey, descriptor);
    } catch (error) {
      Log.error(
        `[WorkflowScheduler] Failed to refresh schedule for ${workflowKey}:`,
        error
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timersByWorkflow.values())
      this.options.timers.clearTimeout(timer);
    this.timersByWorkflow.clear();
  }

  private async armFromDescriptor(
    workflowKey: WorkflowKey,
    descriptor: WorkflowLineageDescriptor
  ): Promise<void> {
    this.clearTimer(workflowKey);
    const schedule = descriptor.schedule;
    if (
      this.disposed ||
      !schedule?.enabled ||
      schedule.hostId !== this.options.getHostId()
    )
      return;
    const now = this.options.now();
    let nextAt = descriptor.scheduleNextRunAt;
    if (nextAt === undefined || nextAt <= now) {
      nextAt = nextScheduleOccurrence(schedule, now) ?? undefined;
      if (descriptor.scheduleNextRunAt !== nextAt) {
        await this.writeMetadata(workflowKey, (current) => {
          const updated = { ...current };
          if (nextAt === undefined) delete updated.scheduleNextRunAt;
          else updated.scheduleNextRunAt = nextAt;
          if (
            descriptor.scheduleNextRunAt !== undefined &&
            descriptor.scheduleNextRunAt <= now
          )
            updated.scheduleLastMissedAt = descriptor.scheduleNextRunAt;
          return updated;
        });
      }
    }
    if (nextAt === null || nextAt === undefined) return;
    this.arm(workflowKey, nextAt);
  }

  private arm(workflowKey: WorkflowKey, occurrenceAt: number): void {
    if (this.disposed) return;
    if (occurrenceAt <= this.options.now()) {
      Log.warn(
        `[WorkflowScheduler] Refusing to arm past occurrence for ${workflowKey}`
      );
      return;
    }
    // A refresh can re-arm while a wake is awaiting I/O; keep one timer per lineage.
    this.clearTimer(workflowKey);
    const delay = Math.max(
      0,
      Math.min(occurrenceAt - this.options.now(), MAX_TIMER_DELAY_MS)
    );
    const timer = this.options.timers.setTimeout(() => {
      this.timersByWorkflow.delete(workflowKey);
      void this.onWake(workflowKey, occurrenceAt);
    }, delay);
    this.timersByWorkflow.set(workflowKey, timer);
  }

  private async onWake(
    workflowKey: WorkflowKey,
    scheduledAt: number
  ): Promise<void> {
    if (this.disposed) return;
    try {
      const descriptor = await this.options.lineageRepository.readDescriptor(
        this.options.workspaceRoot,
        workflowKey
      );
      const schedule = descriptor.schedule;
      if (!schedule?.enabled || schedule.hostId !== this.options.getHostId())
        return;
      const now = this.options.now();
      if (now < scheduledAt) {
        this.arm(workflowKey, scheduledAt);
        return;
      }
      const late = now - scheduledAt > 60_000;
      const nextAt = nextScheduleOccurrence(schedule, late ? now : scheduledAt);
      if (late) {
        await this.writeMetadata(workflowKey, (current) => {
          const updated = { ...current, scheduleLastMissedAt: scheduledAt };
          if (nextAt === null) delete updated.scheduleNextRunAt;
          else updated.scheduleNextRunAt = nextAt;
          return updated;
        });
        if (nextAt !== null) this.arm(workflowKey, nextAt);
        return;
      }
      const overlap = await this.options.isLineageRunning(workflowKey);
      if (overlap)
        Log.info(
          `[WorkflowScheduler] Skipping scheduled occurrence for ${workflowKey}; lineage is already running`
        );
      else {
        try {
          await this.options.fire(workflowKey);
          await this.writeMetadata(workflowKey, (current) => {
            const updated = { ...current, scheduleLastRunAt: scheduledAt };
            if (nextAt === null) delete updated.scheduleNextRunAt;
            else updated.scheduleNextRunAt = nextAt;
            // A one-shot is used up once it has run: drop it so the lineage
            // no longer reads as scheduled. Only the same one-shot, in case
            // the user saved a new schedule while the fire was starting.
            if (
              current.schedule &&
              "at" in current.schedule.trigger &&
              "at" in schedule.trigger &&
              current.schedule.trigger.at === schedule.trigger.at
            ) {
              delete updated.schedule;
              delete updated.scheduleLastMissedAt;
            }
            return updated;
          });
        } catch (error) {
          Log.error(
            `[WorkflowScheduler] Scheduled fire failed for ${workflowKey}:`,
            error
          );
          await this.writeNextMetadata(workflowKey, nextAt);
        }
      }
      if (overlap) await this.writeNextMetadata(workflowKey, nextAt);
      if (nextAt !== null) this.arm(workflowKey, nextAt);
    } catch (error) {
      Log.error(
        `[WorkflowScheduler] Schedule wake failed for ${workflowKey}:`,
        error
      );
      await this.refresh(workflowKey);
    }
  }

  private async writeMetadata(
    workflowKey: WorkflowKey,
    mutate: (descriptor: WorkflowLineageDescriptor) => WorkflowLineageDescriptor
  ): Promise<void> {
    await this.options.lineageRepository.updateDescriptorMetadata(
      this.options.workspaceRoot,
      workflowKey,
      mutate
    );
  }

  private writeNextMetadata(
    workflowKey: WorkflowKey,
    nextAt: number | null
  ): Promise<void> {
    return this.writeMetadata(workflowKey, (current) => {
      const updated = { ...current };
      if (nextAt === null) delete updated.scheduleNextRunAt;
      else updated.scheduleNextRunAt = nextAt;
      return updated;
    });
  }

  private clearTimer(workflowKey: WorkflowKey): void {
    const timer = this.timersByWorkflow.get(workflowKey);
    if (timer !== undefined) this.options.timers.clearTimeout(timer);
    this.timersByWorkflow.delete(workflowKey);
  }
}

/** Production overlap check shared by orchestrator construction. */
export async function isLineageRunningOnDisk(
  workspaceRoot: string,
  workflowKey: WorkflowKey
): Promise<boolean> {
  try {
    const inspection = await readWorkflowLockInspection(
      workspaceRoot,
      workflowKey
    );
    return inspection.liveness === WORKFLOW_LOCK_LIVENESS.ACTIVE;
  } catch (error) {
    Log.warn(
      `[WorkflowScheduler] Could not inspect runner lock for ${workflowKey}:`,
      error
    );
    return false;
  }
}

/** Read the current definition revision for a schedule fire address. */
export async function readScheduleDefinitionRevision(
  workspaceRoot: string,
  descriptor: WorkflowLineageDescriptor
): Promise<number> {
  const filePath = descriptor.latestRunRef
    ? WorkflowPaths.runFilePath(
        workspaceRoot,
        descriptor.workflowKey,
        descriptor.latestRunRef
      )
    : WorkflowPaths.draftFilePath(workspaceRoot, descriptor.workflowKey);
  const definition = JSON.parse(
    await fs.promises.readFile(filePath, "utf8")
  ) as { definitionRevision?: number };
  return definition.definitionRevision ?? 1;
}
