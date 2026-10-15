import * as fs from "fs/promises";
import type { Dirent } from "fs";
import {
  EXECUTION_STATES,
  RUN_OUTCOME_BUCKETS,
  WORKSPACE_STATS_BACKFILL_STATES,
  type RunOutcomeBucket,
  type WorkspaceStatsBackfillState,
} from "../../../../types/DashboardConstants";
import type {
  LifetimeHarnessContribution,
  WorkspaceStatsSnapshot,
} from "../../../../types/UsageTypes";
import type { WorkflowRunManifest } from "../../../../types/WorkflowTimelineTypes";
import type { RunRef, WorkflowKey } from "../../../../types/CtrlYokeTypes";
import {
  contributionFromManifest,
  LifetimeUsageStore,
  LIFETIME_USAGE_ERROR_CODES,
  LIFETIME_USAGE_SCHEMA_VERSION,
  type LifetimeUsageStoreData,
} from "./LifetimeUsageStore";
import { isNewerSchemaError } from "../../../../utils/PersistedSchemaGuard";
import {
  isLineageDirEntry,
  isRunDirEntry,
  lineageDir,
  manifestPath,
  runsRoot,
} from "../../../../utils/WorkflowPaths";

/** Keep manifest reads aligned with OutputHistoryManager's run-list scanner. */
export const WORKSPACE_STATS_READ_BATCH_SIZE = 32;

export const WORKSPACE_STATS_ERROR_CODES = {
  STORE_READ_FAILED: "workspace-stats-store-read-failed",
  LINEAGE_COUNT_FAILED: "workspace-stats-lineage-count-failed",
  BACKFILL_FAILED: "workspace-stats-backfill-failed",
} as const;

interface BackfillProgress {
  state: WorkspaceStatsBackfillState;
  scanned: number;
  total: number;
}

interface ManifestReadResult {
  runRef: RunRef;
  manifest?: WorkflowRunManifest;
}

export interface WorkspaceStatsServiceOptions {
  stat?: typeof fs.stat;
}

function emptyContribution(): LifetimeHarnessContribution {
  return {
    input: 0,
    output: 0,
    total: 0,
    attemptCount: 0,
    reportedAttemptCount: 0,
  };
}

function emptyOutcomes(): Record<RunOutcomeBucket, number> {
  return {
    [RUN_OUTCOME_BUCKETS.COMPLETED]: 0,
    [RUN_OUTCOME_BUCKETS.STOPPED]: 0,
    [RUN_OUTCOME_BUCKETS.ERROR]: 0,
  };
}

function emptyData(now: number): LifetimeUsageStoreData {
  return {
    schemaVersion: LIFETIME_USAGE_SCHEMA_VERSION,
    updatedAt: now,
    totals: emptyContribution(),
    byHarness: {},
    outcomes: emptyOutcomes(),
    runCount: 0,
    totalActiveExecutionMs: 0,
    wallClockDurationRunCount: 0,
    skippedRunCount: 0,
    lineages: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManifest(value: unknown): value is WorkflowRunManifest {
  if (!isRecord(value)) return false;
  return (
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    (value.completedAt === undefined ||
      (typeof value.completedAt === "number" &&
        Number.isFinite(value.completedAt))) &&
    typeof value.lastUpdatedAt === "number" &&
    Number.isFinite(value.lastUpdatedAt) &&
    typeof value.stepCount === "number" &&
    Number.isFinite(value.stepCount) &&
    Object.values(EXECUTION_STATES).includes(
      value.executionState as (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES]
    )
  );
}

function manifestReadBatch(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runRefs: readonly RunRef[]
): Promise<ManifestReadResult[]> {
  return Promise.all(
    runRefs.map(async (runRef) => {
      try {
        const raw = await fs.readFile(
          manifestPath(workspaceRoot, workflowKey, runRef),
          "utf8"
        );
        const parsed: unknown = JSON.parse(raw);
        return {
          runRef,
          manifest: isManifest(parsed) ? parsed : undefined,
        };
      } catch {
        return { runRef };
      }
    })
  );
}

export class WorkspaceStatsService {
  private readonly lifetimeStore: LifetimeUsageStore;
  private progress: BackfillProgress = {
    state: WORKSPACE_STATS_BACKFILL_STATES.IDLE,
    scanned: 0,
    total: 0,
  };
  private backfillPromise: Promise<void> | undefined;
  private backfillErrorCode: string | undefined;
  private storeReadErrorCode: string | undefined;
  private readonly stat: typeof fs.stat;

  constructor(
    private readonly workspaceRoot: string,
    lifetimeStore?: LifetimeUsageStore,
    options: WorkspaceStatsServiceOptions = {}
  ) {
    this.lifetimeStore = lifetimeStore ?? new LifetimeUsageStore(workspaceRoot);
    this.stat = options.stat ?? fs.stat;
  }

  /** Return the current rollup and start the on-demand backfill if needed. */
  async getSnapshot(): Promise<WorkspaceStatsSnapshot> {
    const now = Date.now();
    const [data, workflowResult] = await Promise.all([
      this.readStore(now),
      this.countWorkflows(),
    ]);
    if (this.progress.state === WORKSPACE_STATS_BACKFILL_STATES.IDLE) {
      this.startBackfill();
    }
    return this.toSnapshot(data, workflowResult.count, {
      errorCode:
        this.backfillErrorCode ??
        this.storeReadErrorCode ??
        workflowResult.errorCode,
    });
  }

  /** Run the on-demand scan to completion, then return its final snapshot. */
  async refresh(): Promise<WorkspaceStatsSnapshot> {
    await this.startBackfill();
    return this.getSnapshot();
  }

  /** Exposed for callers that want to begin work without waiting for it. */
  startBackfill(): Promise<void> {
    if (this.backfillPromise) return this.backfillPromise;
    this.progress = {
      state: WORKSPACE_STATS_BACKFILL_STATES.RUNNING,
      scanned: 0,
      total: 0,
    };
    this.backfillErrorCode = undefined;
    const promise = this.runBackfill().finally(() => {
      this.backfillPromise = undefined;
    });
    this.backfillPromise = promise;
    return promise;
  }

  private async readStore(now: number): Promise<LifetimeUsageStoreData> {
    try {
      const data = await this.lifetimeStore.read(now);
      this.storeReadErrorCode = this.lifetimeStore.getLastErrorCode();
      return data;
    } catch (error) {
      this.storeReadErrorCode = isNewerSchemaError(error)
        ? LIFETIME_USAGE_ERROR_CODES.NEWER_DATA
        : WORKSPACE_STATS_ERROR_CODES.STORE_READ_FAILED;
      return emptyData(now);
    }
  }

  private async countWorkflows(): Promise<{
    count: number;
    errorCode?: string;
  }> {
    try {
      const entries = await fs.readdir(runsRoot(this.workspaceRoot), {
        withFileTypes: true,
      });
      return { count: entries.filter(isLineageDirEntry).length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { count: 0 };
      }
      return {
        count: 0,
        errorCode: WORKSPACE_STATS_ERROR_CODES.LINEAGE_COUNT_FAILED,
      };
    }
  }

  private async runBackfill(): Promise<void> {
    try {
      const data = await this.lifetimeStore.read();
      let lineageEntries: Dirent[];
      try {
        lineageEntries = await fs.readdir(runsRoot(this.workspaceRoot), {
          withFileTypes: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.progress = {
            ...this.progress,
            state: WORKSPACE_STATS_BACKFILL_STATES.COMPLETE,
          };
          return;
        }
        throw error;
      }

      for (const entry of lineageEntries) {
        if (!isLineageDirEntry(entry)) continue;
        await this.scanLineage(entry.name as WorkflowKey, data);
      }
      this.progress = {
        ...this.progress,
        state: this.backfillErrorCode
          ? WORKSPACE_STATS_BACKFILL_STATES.ERROR
          : WORKSPACE_STATS_BACKFILL_STATES.COMPLETE,
      };
    } catch {
      this.backfillErrorCode = WORKSPACE_STATS_ERROR_CODES.BACKFILL_FAILED;
      this.progress = {
        ...this.progress,
        state: WORKSPACE_STATS_BACKFILL_STATES.ERROR,
      };
    }
  }

  private async scanLineage(
    workflowKey: WorkflowKey,
    data: LifetimeUsageStoreData
  ): Promise<void> {
    const directory = lineageDir(this.workspaceRoot, workflowKey);
    const dirMtimeMs = await this.readDirectoryMtime(directory);
    const existing = data.lineages[workflowKey];
    if (
      dirMtimeMs !== undefined &&
      existing?.dirMtimeMs !== undefined &&
      existing.backfillComplete !== false &&
      dirMtimeMs === existing.dirMtimeMs
    ) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      this.backfillErrorCode = WORKSPACE_STATS_ERROR_CODES.BACKFILL_FAILED;
      return;
    }
    const allRunRefs = entries
      .filter(isRunDirEntry)
      .map((entry) => entry.name as RunRef)
      .sort((left, right) => left.localeCompare(right));
    const hasOlderRun =
      existing !== undefined &&
      allRunRefs.some((runRef) => runRef < existing.countedFrom);
    const wasLiveUpsert =
      existing !== undefined &&
      existing.dirMtimeMs === undefined &&
      existing.backfillComplete !== false;
    if (hasOlderRun || wasLiveUpsert) {
      await this.lifetimeStore.rebuildLineage(workflowKey, Date.now());
      this.progress.total += allRunRefs.length;
      this.progress.scanned += allRunRefs.length;
      return;
    }
    const runRefs = allRunRefs
      .filter(
        (runRef) =>
          !existing ||
          runRef < existing.countedFrom ||
          runRef > existing.countedThrough
      );
    this.progress.total += runRefs.length;

    for (
      let startIndex = 0;
      startIndex < runRefs.length;
      startIndex += WORKSPACE_STATS_READ_BATCH_SIZE
    ) {
      const batchRunRefs = runRefs.slice(
        startIndex,
        startIndex + WORKSPACE_STATS_READ_BATCH_SIZE
      );
      const results = await manifestReadBatch(
        this.workspaceRoot,
        workflowKey,
        batchRunRefs
      );
      const contributions = results
        .filter((result) => result.manifest !== undefined)
        .map((result) =>
          contributionFromManifest(workflowKey, result.runRef, result.manifest!)
        );
      await this.lifetimeStore.applyBackfillBatch(
        {
          workflowKey,
          runRefs: batchRunRefs,
          contributions,
          skippedRunCount: batchRunRefs.length - contributions.length,
          dirMtimeMs,
        },
        Date.now()
      );
      this.progress.scanned += batchRunRefs.length;
    }

    if (runRefs.length === 0) {
      await this.lifetimeStore.applyBackfillBatch(
        {
          workflowKey,
          runRefs: [],
          contributions: [],
          skippedRunCount: 0,
          dirMtimeMs,
        },
        Date.now()
      );
    }
    await this.lifetimeStore.markLineageBackfillComplete(
      workflowKey,
      dirMtimeMs,
      Date.now()
    );
  }

  private async readDirectoryMtime(
    directory: string
  ): Promise<number | undefined> {
    try {
      const stats = await this.stat(directory);
      return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : undefined;
    } catch {
      return undefined;
    }
  }

  private toSnapshot(
    data: LifetimeUsageStoreData,
    workflowCount: number,
    errors: { errorCode?: string }
  ): WorkspaceStatsSnapshot {
    return {
      updatedAt: data.updatedAt,
      workflowCount,
      runCount: data.runCount,
      outcomes: data.outcomes,
      totalActiveExecutionMs: data.totalActiveExecutionMs,
      wallClockDurationRunCount: data.wallClockDurationRunCount,
      skippedRunCount: data.skippedRunCount,
      totals: data.totals,
      byHarness: data.byHarness,
      backfill: { ...this.progress },
      ...(errors.errorCode ? { errorCode: errors.errorCode } : {}),
    };
  }
}
