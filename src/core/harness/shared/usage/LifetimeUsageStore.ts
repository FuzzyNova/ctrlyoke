import * as fs from "fs/promises";
import type { Dirent } from "fs";
import * as path from "path";
import {
  ATTEMPT_COST_SOURCES,
  EXECUTION_STATES,
  HARNESS_IDS,
  RUN_OUTCOME_BUCKETS,
  WORKFLOW_TOKEN_COVERAGE,
  type AttemptCostSource,
  type HarnessId,
  type RunOutcomeBucket,
} from "../../../../types/DashboardConstants";
import type {
  LifetimeHarnessContribution,
  LifetimeRunContribution,
} from "../../../../types/UsageTypes";
import type {
  RunRef,
  WorkflowHarnessTokenTotals,
  WorkflowKey,
} from "../../../../types/CtrlYokeTypes";
import type { WorkflowRunManifest } from "../../../../types/WorkflowTimelineTypes";
import { renameWithTransientRetry } from "../../../../utils/AtomicFileUtils";
import { withFileLock } from "../../../../utils/FileLockUtils";
import {
  assertValidRunRef,
  assertValidWorkflowKey,
  isRunDirEntry,
  lineageDir,
  manifestPath,
} from "../../../../utils/WorkflowPaths";
import { lifetimeStatsPath } from "../../../../utils/UsagePaths";
import {
  assertWritableSchema,
  CURRENT_SCHEMA_VERSIONS,
  hasNewerSchema,
  isNewerSchemaError,
  PERSISTED_STORES,
} from "../../../../utils/PersistedSchemaGuard";
import { migrateToCurrent } from "../../../../utils/FormatMigrations";

export const LIFETIME_USAGE_SCHEMA_VERSION =
  CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.LIFETIME_USAGE];

export const LIFETIME_USAGE_ERROR_CODES = {
  MALFORMED_DATA: "malformed-lifetime-usage-data",
  /** Written by a newer ctrlyoke: left untouched, and not updated here. */
  NEWER_DATA: "lifetime-usage-newer-data",
  WRITE_FAILED: "lifetime-usage-write-failed",
} as const;

export interface LifetimeUsageStoreData {
  schemaVersion: typeof LIFETIME_USAGE_SCHEMA_VERSION;
  updatedAt: number;
  totals: LifetimeHarnessContribution;
  byHarness: Partial<Record<HarnessId, LifetimeHarnessContribution>>;
  outcomes: Record<RunOutcomeBucket, number>;
  runCount: number;
  totalActiveExecutionMs: number;
  wallClockDurationRunCount: number;
  skippedRunCount: number;
  lineages: Record<
    WorkflowKey,
    {
      subtotal: LifetimeHarnessContribution;
      byHarness: Partial<Record<HarnessId, LifetimeHarnessContribution>>;
      runCount: number;
      skippedRunCount: number;
      outcomes: Record<RunOutcomeBucket, number>;
      activeExecutionMs: number;
      wallClockDurationRunCount: number;
      countedFrom: RunRef;
      countedThrough: RunRef;
      dirMtimeMs?: number;
      /** False only while a checkpointed backfill still has work to resume. */
      backfillComplete?: boolean;
    }
  >;
}

const RECENT_CONTRIBUTION_CACHE_SIZE = 200;
const VALID_HARNESS_IDS = new Set(Object.values(HARNESS_IDS));
const OUTCOME_BUCKETS = Object.values(RUN_OUTCOME_BUCKETS);

type LineageData = LifetimeUsageStoreData["lineages"][WorkflowKey];

interface ScannedLineage {
  lineage?: LineageData;
  contributions: LifetimeRunContribution[];
  skippedRunCount: number;
}

export interface LifetimeBackfillBatch {
  workflowKey: WorkflowKey;
  runRefs: readonly RunRef[];
  contributions: readonly LifetimeRunContribution[];
  skippedRunCount: number;
  dirMtimeMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function requiredNumeric(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stableCostSources(
  sources: readonly AttemptCostSource[] | undefined
): AttemptCostSource[] | undefined {
  if (!sources?.length) return undefined;
  const sourceSet = new Set(sources);
  const ordered = Object.values(ATTEMPT_COST_SOURCES).filter((source) =>
    sourceSet.has(source)
  );
  return ordered.length ? ordered : undefined;
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

function emptyStore(now: number): LifetimeUsageStoreData {
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

function cloneContribution(
  contribution: LifetimeRunContribution
): LifetimeRunContribution {
  return {
    ...contribution,
    byHarness: Object.fromEntries(
      Object.entries(contribution.byHarness).map(([harnessId, values]) => [
        harnessId,
        values
          ? { ...values, costSources: values.costSources?.slice() }
          : values,
      ])
    ) as Partial<Record<HarnessId, LifetimeHarnessContribution>>,
  };
}

function addHarnessContribution(
  left: LifetimeHarnessContribution | undefined,
  right: LifetimeHarnessContribution,
  sign: 1 | -1
): LifetimeHarnessContribution {
  const current = left ?? emptyContribution();
  const result: LifetimeHarnessContribution = {
    input: Math.max(0, numeric(current.input) + sign * numeric(right.input)),
    output: Math.max(0, numeric(current.output) + sign * numeric(right.output)),
    total: Math.max(0, numeric(current.total) + sign * numeric(right.total)),
    attemptCount: Math.max(
      0,
      numeric(current.attemptCount) + sign * numeric(right.attemptCount)
    ),
    reportedAttemptCount: Math.max(
      0,
      numeric(current.reportedAttemptCount) +
        sign * numeric(right.reportedAttemptCount)
    ),
  };
  for (const field of [
    "cachedInput",
    "cacheCreated",
    "reasoningOutput",
    "costUsd",
  ] as const) {
    const value = Math.max(
      0,
      numeric(current[field]) + sign * numeric(right[field])
    );
    if (value > 0) result[field] = value;
  }
  if (sign === 1) {
    result.costSources = stableCostSources([
      ...(current.costSources ?? []),
      ...(right.costSources ?? []),
    ]);
    if (current.costPartial || right.costPartial) result.costPartial = true;
    if (current.partial || right.partial) result.partial = true;
  }
  return result;
}

function addByHarness(
  target: Partial<Record<HarnessId, LifetimeHarnessContribution>>,
  source: Partial<Record<HarnessId, LifetimeHarnessContribution>>,
  sign: 1 | -1
): void {
  for (const [harnessId, values] of Object.entries(source)) {
    if (!values) continue;
    const updated = addHarnessContribution(
      target[harnessId as HarnessId],
      values,
      sign
    );
    if (
      updated.input === 0 &&
      updated.output === 0 &&
      updated.total === 0 &&
      updated.attemptCount === 0 &&
      updated.reportedAttemptCount === 0
    ) {
      delete target[harnessId as HarnessId];
    } else {
      target[harnessId as HarnessId] = updated;
    }
  }
}

function aggregateByHarness(
  source: Partial<Record<HarnessId, LifetimeHarnessContribution>>
): LifetimeHarnessContribution {
  const result = emptyContribution();
  for (const values of Object.values(source)) {
    if (!values) continue;
    const next = addHarnessContribution(result, values, 1);
    Object.assign(result, next);
  }
  return result;
}

function outcomeForState(
  executionState: LifetimeRunContribution["executionState"]
): RunOutcomeBucket | undefined {
  if (executionState === EXECUTION_STATES.COMPLETED) {
    return RUN_OUTCOME_BUCKETS.COMPLETED;
  }
  if (executionState === EXECUTION_STATES.STOPPED) {
    return RUN_OUTCOME_BUCKETS.STOPPED;
  }
  if (executionState === EXECUTION_STATES.ERROR) {
    return RUN_OUTCOME_BUCKETS.ERROR;
  }
  return undefined;
}

function applyRunToLineage(
  lineage: LineageData,
  contribution: LifetimeRunContribution,
  sign: 1 | -1
): void {
  addByHarness(lineage.byHarness, contribution.byHarness, sign);
  const subtotal = aggregateByHarness(lineage.byHarness);
  Object.assign(lineage.subtotal, subtotal);
  lineage.runCount = Math.max(0, lineage.runCount + sign);
  const outcome = outcomeForState(contribution.executionState);
  if (outcome) {
    lineage.outcomes[outcome] = Math.max(0, lineage.outcomes[outcome] + sign);
  }
  lineage.activeExecutionMs = Math.max(
    0,
    lineage.activeExecutionMs + sign * numeric(contribution.activeExecutionMs)
  );
  if (contribution.durationIsWallClock) {
    lineage.wallClockDurationRunCount = Math.max(
      0,
      lineage.wallClockDurationRunCount + sign
    );
  }
}

function addRunToStore(
  data: LifetimeUsageStoreData,
  contribution: LifetimeRunContribution,
  sign: 1 | -1
): void {
  addByHarness(data.byHarness, contribution.byHarness, sign);
  data.totals = aggregateByHarness(data.byHarness);
  data.runCount = Math.max(0, data.runCount + sign);
  const outcome = outcomeForState(contribution.executionState);
  if (outcome) {
    data.outcomes[outcome] = Math.max(0, data.outcomes[outcome] + sign);
  }
  data.totalActiveExecutionMs = Math.max(
    0,
    data.totalActiveExecutionMs + sign * numeric(contribution.activeExecutionMs)
  );
  if (contribution.durationIsWallClock) {
    data.wallClockDurationRunCount = Math.max(
      0,
      data.wallClockDurationRunCount + sign
    );
  }
}

function addLineageToStore(
  data: LifetimeUsageStoreData,
  lineage: LineageData,
  sign: 1 | -1
): void {
  addByHarness(data.byHarness, lineage.byHarness, sign);
  data.totals = aggregateByHarness(data.byHarness);
  data.runCount = Math.max(0, data.runCount + sign * lineage.runCount);
  for (const bucket of OUTCOME_BUCKETS) {
    data.outcomes[bucket] = Math.max(
      0,
      data.outcomes[bucket] + sign * lineage.outcomes[bucket]
    );
  }
  data.totalActiveExecutionMs = Math.max(
    0,
    data.totalActiveExecutionMs + sign * lineage.activeExecutionMs
  );
  data.wallClockDurationRunCount = Math.max(
    0,
    data.wallClockDurationRunCount + sign * lineage.wallClockDurationRunCount
  );
}

function recomputeGrandTotals(data: LifetimeUsageStoreData): void {
  data.totals = emptyContribution();
  data.byHarness = {};
  data.outcomes = emptyOutcomes();
  data.runCount = 0;
  data.totalActiveExecutionMs = 0;
  data.wallClockDurationRunCount = 0;
  data.skippedRunCount = 0;
  for (const lineage of Object.values(data.lineages)) {
    addLineageToStore(data, lineage, 1);
    data.skippedRunCount += numeric(lineage.skippedRunCount);
  }
}

function normalizeContribution(
  contribution: LifetimeRunContribution
): LifetimeRunContribution {
  const byHarness: Partial<Record<HarnessId, LifetimeHarnessContribution>> = {};
  for (const [harnessId, values] of Object.entries(contribution.byHarness)) {
    if (!VALID_HARNESS_IDS.has(harnessId as HarnessId) || !values) continue;
    const normalized: LifetimeHarnessContribution = {
      input: numeric(values.input),
      output: numeric(values.output),
      total: numeric(values.total),
      attemptCount: numeric(values.attemptCount),
      reportedAttemptCount: numeric(values.reportedAttemptCount),
    };
    for (const field of [
      "cachedInput",
      "cacheCreated",
      "reasoningOutput",
      "costUsd",
    ] as const) {
      const value = numeric(values[field]);
      if (value > 0) normalized[field] = value;
    }
    normalized.costSources = stableCostSources(values.costSources);
    if (values.costPartial) normalized.costPartial = true;
    if (values.partial) normalized.partial = true;
    byHarness[harnessId as HarnessId] = normalized;
  }
  return {
    workflowKey: contribution.workflowKey,
    runRef: contribution.runRef,
    updatedAt: numeric(contribution.updatedAt),
    startedAt: numeric(contribution.startedAt),
    ...(contribution.completedAt !== undefined
      ? { completedAt: numeric(contribution.completedAt) }
      : {}),
    executionState: contribution.executionState,
    stepCount: numeric(contribution.stepCount),
    ...(contribution.activeExecutionMs !== undefined
      ? { activeExecutionMs: numeric(contribution.activeExecutionMs) }
      : {}),
    ...(contribution.durationIsWallClock ? { durationIsWallClock: true } : {}),
    byHarness,
  };
}

function contributionFromManifest(
  workflowKey: WorkflowKey,
  runRef: RunRef,
  manifest: WorkflowRunManifest
): LifetimeRunContribution {
  const activeExecutionMs =
    manifest.activeExecutionMs ??
    (manifest.completedAt === undefined
      ? undefined
      : Math.max(0, manifest.completedAt - manifest.startedAt));
  return normalizeContribution({
    workflowKey,
    runRef,
    updatedAt: manifest.lastUpdatedAt,
    startedAt: manifest.startedAt,
    ...(manifest.completedAt !== undefined
      ? { completedAt: manifest.completedAt }
      : {}),
    executionState: manifest.executionState,
    stepCount: manifest.stepCount,
    ...(activeExecutionMs !== undefined ? { activeExecutionMs } : {}),
    ...(manifest.activeExecutionMs === undefined &&
    activeExecutionMs !== undefined
      ? { durationIsWallClock: true }
      : {}),
    byHarness: Object.fromEntries(
      Object.entries(manifest.tokenTotals?.byHarness ?? {}).map(
        ([harnessId, values]) => [
          harnessId,
          values ? toLifetimeHarnessContribution(values) : values,
        ]
      )
    ) as Partial<Record<HarnessId, LifetimeHarnessContribution>>,
  });
}

function toLifetimeHarnessContribution(
  totals: WorkflowHarnessTokenTotals
): LifetimeHarnessContribution {
  return {
    input: numeric(totals.input),
    output: numeric(totals.output),
    total: numeric(totals.total),
    attemptCount: numeric(totals.attemptCount),
    reportedAttemptCount: numeric(totals.reportedAttemptCount),
    ...(numeric(totals.cachedInput) > 0
      ? { cachedInput: numeric(totals.cachedInput) }
      : {}),
    ...(numeric(totals.cacheCreated) > 0
      ? { cacheCreated: numeric(totals.cacheCreated) }
      : {}),
    ...(numeric(totals.reasoningOutput) > 0
      ? { reasoningOutput: numeric(totals.reasoningOutput) }
      : {}),
    ...(numeric(totals.costUsd) > 0
      ? { costUsd: numeric(totals.costUsd) }
      : {}),
    ...(stableCostSources(totals.costSources) !== undefined
      ? { costSources: stableCostSources(totals.costSources) }
      : {}),
    ...(totals.costPartial ? { costPartial: true } : {}),
    ...(totals.coverage === WORKFLOW_TOKEN_COVERAGE.PARTIAL
      ? { partial: true }
      : {}),
  };
}

function validateContributionTotals(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const field of [
    "input",
    "output",
    "total",
    "attemptCount",
    "reportedAttemptCount",
  ]) {
    if (!requiredNumeric(value[field])) return false;
  }
  return true;
}

/**
 * A document written before lineages carried their own `skippedRunCount`.
 * Its totals are not wrong data, just an older shape, so it is rebuilt from
 * the run history quietly instead of being quarantined as corrupt.
 */
function predatesLineageSkippedRunCounts(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.lineages) &&
    Object.values(value.lineages).some(
      (lineage) => isRecord(lineage) && !("skippedRunCount" in lineage)
    )
  );
}

function validateStore(value: unknown): LifetimeUsageStoreData {
  if (
    !isRecord(value) ||
    value.schemaVersion !== LIFETIME_USAGE_SCHEMA_VERSION ||
    "runs" in value ||
    !requiredNumeric(value.updatedAt) ||
    !validateContributionTotals(value.totals) ||
    !isRecord(value.byHarness) ||
    !isRecord(value.outcomes) ||
    !requiredNumeric(value.runCount) ||
    !requiredNumeric(value.totalActiveExecutionMs) ||
    !requiredNumeric(value.wallClockDurationRunCount) ||
    !requiredNumeric(value.skippedRunCount) ||
    !isRecord(value.lineages)
  ) {
    throw new Error(LIFETIME_USAGE_ERROR_CODES.MALFORMED_DATA);
  }
  for (const bucket of OUTCOME_BUCKETS) {
    if (!requiredNumeric(value.outcomes[bucket])) {
      throw new Error(LIFETIME_USAGE_ERROR_CODES.MALFORMED_DATA);
    }
  }
  for (const [harnessId, contribution] of Object.entries(value.byHarness)) {
    if (
      !VALID_HARNESS_IDS.has(harnessId as HarnessId) ||
      !validateContributionTotals(contribution)
    ) {
      throw new Error(LIFETIME_USAGE_ERROR_CODES.MALFORMED_DATA);
    }
  }
  for (const [workflowKey, lineage] of Object.entries(value.lineages)) {
    try {
      assertValidWorkflowKey(workflowKey);
    } catch {
      throw new Error(LIFETIME_USAGE_ERROR_CODES.MALFORMED_DATA);
    }
    if (
      !isRecord(lineage) ||
      !validateContributionTotals(lineage.subtotal) ||
      !isRecord(lineage.byHarness) ||
      !requiredNumeric(lineage.runCount) ||
      !requiredNumeric(lineage.skippedRunCount) ||
      !isRecord(lineage.outcomes) ||
      !requiredNumeric(lineage.activeExecutionMs) ||
      !requiredNumeric(lineage.wallClockDurationRunCount) ||
      typeof lineage.countedFrom !== "string" ||
      typeof lineage.countedThrough !== "string"
    ) {
      throw new Error(LIFETIME_USAGE_ERROR_CODES.MALFORMED_DATA);
    }
    try {
      assertValidRunRef(lineage.countedFrom);
      assertValidRunRef(lineage.countedThrough);
    } catch {
      throw new Error(LIFETIME_USAGE_ERROR_CODES.MALFORMED_DATA);
    }
    if (
      lineage.dirMtimeMs !== undefined &&
      !requiredNumeric(lineage.dirMtimeMs)
    ) {
      throw new Error(LIFETIME_USAGE_ERROR_CODES.MALFORMED_DATA);
    }
    if (
      lineage.backfillComplete !== undefined &&
      typeof lineage.backfillComplete !== "boolean"
    ) {
      throw new Error(LIFETIME_USAGE_ERROR_CODES.MALFORMED_DATA);
    }
    for (const bucket of OUTCOME_BUCKETS) {
      if (!requiredNumeric(lineage.outcomes[bucket])) {
        throw new Error(LIFETIME_USAGE_ERROR_CODES.MALFORMED_DATA);
      }
    }
  }
  return value as unknown as LifetimeUsageStoreData;
}

function createLineage(
  contribution: LifetimeRunContribution,
  dirMtimeMs?: number
): LineageData {
  const byHarness: Partial<Record<HarnessId, LifetimeHarnessContribution>> = {};
  addByHarness(byHarness, contribution.byHarness, 1);
  const outcome = outcomeForState(contribution.executionState);
  const outcomes = emptyOutcomes();
  if (outcome) outcomes[outcome] = 1;
  return {
    subtotal: aggregateByHarness(byHarness),
    byHarness,
    runCount: 1,
    skippedRunCount: 0,
    outcomes,
    activeExecutionMs: numeric(contribution.activeExecutionMs),
    wallClockDurationRunCount: contribution.durationIsWallClock ? 1 : 0,
    countedFrom: contribution.runRef,
    countedThrough: contribution.runRef,
    backfillComplete: true,
    ...(dirMtimeMs !== undefined ? { dirMtimeMs } : {}),
  };
}

function createEmptyLineage(
  countedFrom: RunRef,
  countedThrough: RunRef,
  dirMtimeMs?: number
): LineageData {
  return {
    subtotal: emptyContribution(),
    byHarness: {},
    runCount: 0,
    skippedRunCount: 0,
    outcomes: emptyOutcomes(),
    activeExecutionMs: 0,
    wallClockDurationRunCount: 0,
    countedFrom,
    countedThrough,
    backfillComplete: false,
    ...(dirMtimeMs !== undefined ? { dirMtimeMs } : {}),
  };
}

function directReplacementSafe(
  previous: LifetimeRunContribution,
  replacement: LifetimeRunContribution
): boolean {
  // Boolean flags and cost provenance are aggregate properties. Without a
  // per-run ledger, a cache hit can replace them exactly only when both runs
  // carry no such metadata. Numeric token and attempt totals remain safe to
  // subtract directly.
  return (
    !previous.durationIsWallClock &&
    !replacement.durationIsWallClock &&
    Object.values(previous.byHarness).every(
      (values) =>
        !values?.costSources && !values?.costPartial && !values?.partial
    ) &&
    Object.values(replacement.byHarness).every(
      (values) =>
        !values?.costSources && !values?.costPartial && !values?.partial
    )
  );
}

export class LifetimeUsageStore {
  private readonly filePath: string;
  private readonly recentContributionCache = new Map<
    string,
    LifetimeRunContribution
  >();
  private lastErrorCode: string | undefined;

  constructor(private readonly workspaceRoot: string) {
    this.filePath = lifetimeStatsPath(workspaceRoot);
  }

  getPath(): string {
    return this.filePath;
  }

  getLastErrorCode(): string | undefined {
    return this.lastErrorCode;
  }

  /** Testable/operational cache eviction; correctness never depends on it. */
  clearRecentContributionCache(): void {
    this.recentContributionCache.clear();
  }

  async read(now: number = Date.now()): Promise<LifetimeUsageStoreData> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    return withFileLock(this.filePath, async () => {
      const data = await this.readOrReset(now);
      data.updatedAt = now;
      await this.writeAtomic(data);
      return data;
    });
  }

  async upsertRunContribution(
    contribution: LifetimeRunContribution,
    now: number = Date.now()
  ): Promise<void> {
    const normalized = normalizeContribution(contribution);
    const cacheKey = `${normalized.workflowKey}/${normalized.runRef}`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      let forceRescan = false;
      for (;;) {
        const decision = await withFileLock(this.filePath, async () => {
          const data = await this.readOrReset(now);
          const lineage = data.lineages[normalized.workflowKey];
          return {
            signature: JSON.stringify(lineage),
            lineage: lineage ? { ...lineage } : undefined,
            rescan:
              forceRescan ||
              (!!lineage &&
                (normalized.runRef < lineage.countedFrom ||
                  (normalized.runRef > lineage.countedThrough &&
                    lineage.backfillComplete === false) ||
                  (normalized.runRef >= lineage.countedFrom &&
                    normalized.runRef <= lineage.countedThrough &&
                    (() => {
                      const previous =
                        this.recentContributionCache.get(cacheKey);
                      return (
                        !previous ||
                        !directReplacementSafe(previous, normalized)
                      );
                    })()))),
          };
        });

        let rescan = decision.rescan;
        if (
          decision.lineage &&
          !rescan &&
          normalized.runRef > decision.lineage.countedThrough
        ) {
          const refs = await this.listLineageRunRefs(normalized.workflowKey);
          rescan = refs.some(
            (runRef) =>
              runRef > decision.lineage!.countedThrough &&
              runRef < normalized.runRef
          );
        }
        if (rescan) {
          await this.rescanLineageWithLock(
            normalized.workflowKey,
            now,
            decision.signature,
            (data) => {
              if (decision.lineage?.backfillComplete === false) {
                const rebuilt = data.lineages[normalized.workflowKey];
                if (rebuilt) {
                  rebuilt.backfillComplete = false;
                  delete rebuilt.dirMtimeMs;
                }
              }
            }
          );
          this.remember(cacheKey, normalized);
          return;
        }

        const applied = await withFileLock(this.filePath, async () => {
          const data = await this.readOrReset(now);
          const existingLineage = data.lineages[normalized.workflowKey];
          if (JSON.stringify(existingLineage) !== decision.signature)
            return false;
          if (!existingLineage) {
            const lineage = createLineage(normalized);
            data.lineages[normalized.workflowKey] = lineage;
            addRunToStore(data, normalized, 1);
            this.remember(cacheKey, normalized);
          } else if (
            normalized.runRef < existingLineage.countedFrom ||
            normalized.runRef > existingLineage.countedThrough
          ) {
            applyRunToLineage(existingLineage, normalized, 1);
            existingLineage.countedThrough = normalized.runRef;
            addRunToStore(data, normalized, 1);
            this.remember(cacheKey, normalized);
          } else {
            const previous = this.recentContributionCache.get(cacheKey);
            if (previous && directReplacementSafe(previous, normalized)) {
              addByHarness(existingLineage.byHarness, previous.byHarness, -1);
              addByHarness(existingLineage.byHarness, normalized.byHarness, 1);
              existingLineage.subtotal = aggregateByHarness(
                existingLineage.byHarness
              );
              existingLineage.activeExecutionMs = Math.max(
                0,
                existingLineage.activeExecutionMs -
                  numeric(previous.activeExecutionMs) +
                  numeric(normalized.activeExecutionMs)
              );
              if (previous.executionState !== normalized.executionState) {
                const previousOutcome = outcomeForState(
                  previous.executionState
                );
                const nextOutcome = outcomeForState(normalized.executionState);
                if (previousOutcome)
                  existingLineage.outcomes[previousOutcome]--;
                if (nextOutcome) existingLineage.outcomes[nextOutcome]++;
              }
              addByHarness(data.byHarness, previous.byHarness, -1);
              addByHarness(data.byHarness, normalized.byHarness, 1);
              data.totals = aggregateByHarness(data.byHarness);
              data.totalActiveExecutionMs = Math.max(
                0,
                data.totalActiveExecutionMs -
                  numeric(previous.activeExecutionMs) +
                  numeric(normalized.activeExecutionMs)
              );
              const previousOutcome = outcomeForState(previous.executionState);
              const nextOutcome = outcomeForState(normalized.executionState);
              if (previousOutcome) data.outcomes[previousOutcome]--;
              if (nextOutcome) data.outcomes[nextOutcome]++;
              this.remember(cacheKey, normalized);
            } else {
              return false;
            }
          }
          data.updatedAt = now;
          await this.writeAtomic(data);
          return true;
        });
        if (applied) return;
        forceRescan = true;
      }
    } catch (error) {
      const wrapped = new Error(LIFETIME_USAGE_ERROR_CODES.WRITE_FAILED);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  /**
   * Apply one bounded backfill batch and checkpoint its interval. The caller
   * supplies every run ref in the batch, including unreadable manifests, so an
   * interrupted scan can resume from the persisted interval without retaining
   * per-run state.
   */
  async applyBackfillBatch(
    batch: LifetimeBackfillBatch,
    now: number = Date.now()
  ): Promise<void> {
    if (batch.runRefs.length === 0) {
      await this.updateLineageDirectoryMtime(
        batch.workflowKey,
        batch.dirMtimeMs,
        now
      );
      return;
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const contributions = new Map(
      batch.contributions.map((contribution) => [
        contribution.runRef,
        normalizeContribution(contribution),
      ])
    );
    try {
      const rebuildNeeded = await withFileLock(this.filePath, async () => {
        const data = await this.readOrReset(now);
        let lineage = data.lineages[batch.workflowKey];
        if (
          lineage &&
          batch.runRefs.some((runRef) => runRef < lineage!.countedFrom)
        ) {
          return true;
        }
        for (const runRef of batch.runRefs) {
          if (
            lineage &&
            runRef >= lineage.countedFrom &&
            runRef <= lineage.countedThrough
          ) {
            continue;
          }
          const contribution = contributions.get(runRef);
          if (!lineage) {
            lineage = contribution
              ? createLineage(contribution, batch.dirMtimeMs)
              : createEmptyLineage(runRef, runRef, batch.dirMtimeMs);
            data.lineages[batch.workflowKey] = lineage;
            if (contribution) addRunToStore(data, contribution, 1);
            else {
              lineage.skippedRunCount++;
              data.skippedRunCount++;
            }
            continue;
          }

          if (contribution) {
            applyRunToLineage(lineage, contribution, 1);
            addRunToStore(data, contribution, 1);
          } else {
            lineage.skippedRunCount++;
            data.skippedRunCount++;
          }
          lineage.countedFrom =
            runRef < lineage.countedFrom ? runRef : lineage.countedFrom;
          lineage.countedThrough =
            runRef > lineage.countedThrough ? runRef : lineage.countedThrough;
        }

        lineage = data.lineages[batch.workflowKey];
        if (lineage) {
          lineage.backfillComplete = false;
          if (batch.dirMtimeMs === undefined) delete lineage.dirMtimeMs;
          else lineage.dirMtimeMs = batch.dirMtimeMs;
        }
        data.updatedAt = now;
        await this.writeAtomic(data);
        return false;
      });
      if (rebuildNeeded) {
        await this.rescanLineageWithLock(
          batch.workflowKey,
          now,
          undefined,
          (data) => {
            const lineage = data.lineages[batch.workflowKey];
            if (!lineage) return;
            lineage.backfillComplete = false;
            if (batch.dirMtimeMs === undefined) delete lineage.dirMtimeMs;
            else lineage.dirMtimeMs = batch.dirMtimeMs;
          }
        );
      }
    } catch (error) {
      const wrapped = new Error(LIFETIME_USAGE_ERROR_CODES.WRITE_FAILED);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  /** Rebuild a lineage from its manifests when the persisted interval has gaps. */
  async rebuildLineage(
    workflowKey: WorkflowKey,
    now: number = Date.now()
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await this.rescanLineageWithLock(workflowKey, now);
    } catch (error) {
      const wrapped = new Error(LIFETIME_USAGE_ERROR_CODES.WRITE_FAILED);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  /** Checkpoint a lineage mtime even when its current interval is complete. */
  private async updateLineageDirectoryMtime(
    workflowKey: WorkflowKey,
    dirMtimeMs: number | undefined,
    now: number
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await withFileLock(this.filePath, async () => {
      const data = await this.readOrReset(now);
      const lineage = data.lineages[workflowKey];
      if (!lineage) return;
      lineage.backfillComplete = true;
      if (dirMtimeMs === undefined) delete lineage.dirMtimeMs;
      else lineage.dirMtimeMs = dirMtimeMs;
      data.updatedAt = now;
      await this.writeAtomic(data);
    });
  }

  /** Mark a lineage complete after its final batch has been checkpointed. */
  async markLineageBackfillComplete(
    workflowKey: WorkflowKey,
    dirMtimeMs: number | undefined,
    now: number = Date.now()
  ): Promise<void> {
    await this.updateLineageDirectoryMtime(workflowKey, dirMtimeMs, now);
  }

  private remember(key: string, contribution: LifetimeRunContribution): void {
    this.recentContributionCache.delete(key);
    this.recentContributionCache.set(key, cloneContribution(contribution));
    while (this.recentContributionCache.size > RECENT_CONTRIBUTION_CACHE_SIZE) {
      const oldest = this.recentContributionCache.keys().next().value;
      if (oldest === undefined) break;
      this.recentContributionCache.delete(oldest);
    }
  }

  private replaceLineage(
    data: LifetimeUsageStoreData,
    workflowKey: WorkflowKey,
    scanned: ScannedLineage
  ): void {
    const previous = data.lineages[workflowKey];
    if (previous) addLineageToStore(data, previous, -1);
    if (scanned.lineage) {
      scanned.lineage.skippedRunCount = scanned.skippedRunCount;
      data.lineages[workflowKey] = scanned.lineage;
      addLineageToStore(data, scanned.lineage, 1);
    } else {
      delete data.lineages[workflowKey];
    }
    // Aggregate flags and cost provenance cannot be subtracted exactly from
    // the lineage-shaped document, so rebuild those derived fields after a
    // revision. Numeric totals still take the cheap lineage swap path above.
    recomputeGrandTotals(data);
  }

  protected async scanLineage(
    workflowKey: WorkflowKey
  ): Promise<ScannedLineage> {
    const directory = lineageDir(this.workspaceRoot, workflowKey);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return { contributions: [], skippedRunCount: 0 };
    }
    const runEntries = entries
      .filter(isRunDirEntry)
      .sort((left, right) => left.name.localeCompare(right.name));
    const contributions: LifetimeRunContribution[] = [];
    let skippedRunCount = 0;
    for (const entry of runEntries) {
      const runRef = entry.name as RunRef;
      try {
        const raw = await fs.readFile(
          manifestPath(this.workspaceRoot, workflowKey, runRef),
          "utf8"
        );
        const manifest = JSON.parse(raw) as WorkflowRunManifest;
        contributions.push(
          contributionFromManifest(workflowKey, runRef, manifest)
        );
      } catch {
        skippedRunCount++;
      }
    }
    if (runEntries.length === 0) {
      return { contributions, skippedRunCount };
    }
    const firstRun = runEntries[0]!.name as RunRef;
    const lastRun = runEntries[runEntries.length - 1]!.name as RunRef;
    const byHarness: Partial<Record<HarnessId, LifetimeHarnessContribution>> =
      {};
    const outcomes = emptyOutcomes();
    let activeExecutionMs = 0;
    let wallClockDurationRunCount = 0;
    for (const contribution of contributions) {
      addByHarness(byHarness, contribution.byHarness, 1);
      const outcome = outcomeForState(contribution.executionState);
      if (outcome) outcomes[outcome]++;
      activeExecutionMs += numeric(contribution.activeExecutionMs);
      if (contribution.durationIsWallClock) wallClockDurationRunCount++;
    }
    const stats = await fs.stat(directory);
    return {
      contributions,
      skippedRunCount,
      lineage: {
        subtotal: aggregateByHarness(byHarness),
        byHarness,
        runCount: contributions.length,
        skippedRunCount,
        outcomes,
        activeExecutionMs,
        wallClockDurationRunCount,
        countedFrom: firstRun,
        countedThrough: lastRun,
        ...(Number.isFinite(stats.mtimeMs)
          ? { dirMtimeMs: stats.mtimeMs }
          : {}),
      },
    };
  }

  private async listLineageRunRefs(
    workflowKey: WorkflowKey
  ): Promise<RunRef[]> {
    try {
      const entries = await fs.readdir(
        lineageDir(this.workspaceRoot, workflowKey),
        {
          withFileTypes: true,
        }
      );
      return entries
        .filter(isRunDirEntry)
        .map((entry) => entry.name as RunRef)
        .sort((left, right) => left.localeCompare(right));
    } catch {
      return [];
    }
  }

  /** Scan manifests without the store lock, then replace the lineage under it. */
  private async rescanLineageWithLock(
    workflowKey: WorkflowKey,
    now: number,
    expectedSignature?: string,
    afterReplace?: (data: LifetimeUsageStoreData) => void
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let signature = expectedSignature;
    if (signature === undefined) {
      signature = await withFileLock(this.filePath, async () => {
        const data = await this.readOrReset(now);
        return JSON.stringify(data.lineages[workflowKey]);
      });
    }

    for (;;) {
      const scanned = await this.scanLineage(workflowKey);
      const result = await withFileLock(this.filePath, async () => {
        const data = await this.readOrReset(now);
        const currentSignature = JSON.stringify(data.lineages[workflowKey]);
        if (currentSignature !== signature) return { retry: currentSignature };
        this.replaceLineage(data, workflowKey, scanned);
        afterReplace?.(data);
        data.updatedAt = now;
        await this.writeAtomic(data);
        return { retry: undefined };
      });
      if (result.retry === undefined) return;
      signature = result.retry;
    }
  }

  /**
   * The parsed file, `undefined` when absent. Throws `NewerSchemaError` for a
   * file a newer ctrlyoke wrote, so no caller rewrites or quarantines it.
   */
  private async readExisting(): Promise<unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (hasNewerSchema(PERSISTED_STORES.LIFETIME_USAGE, parsed)) {
      this.lastErrorCode = LIFETIME_USAGE_ERROR_CODES.NEWER_DATA;
      assertWritableSchema(
        PERSISTED_STORES.LIFETIME_USAGE,
        parsed,
        this.filePath
      );
    }
    return migrateToCurrent(PERSISTED_STORES.LIFETIME_USAGE, parsed).doc;
  }

  private async readOrReset(now: number): Promise<LifetimeUsageStoreData> {
    try {
      const parsed = await this.readExisting();
      return parsed === undefined || predatesLineageSkippedRunCounts(parsed)
        ? emptyStore(now)
        : validateStore(parsed);
    } catch (error) {
      if (isNewerSchemaError(error)) throw error;
      this.lastErrorCode = LIFETIME_USAGE_ERROR_CODES.MALFORMED_DATA;
      await this.quarantineMalformedFile();
      return emptyStore(now);
    }
  }

  private async quarantineMalformedFile(): Promise<void> {
    try {
      await fs.rename(
        this.filePath,
        `${this.filePath}.corrupt-${Date.now()}.json`
      );
    } catch {
      // Recovery is best effort; callers receive a fresh in-memory store.
    }
  }

  private async writeAtomic(data: LifetimeUsageStoreData): Promise<void> {
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
      await renameWithTransientRetry(tempPath, this.filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export { contributionFromManifest };
