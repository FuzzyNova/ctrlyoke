import * as fs from "fs/promises";
import * as path from "path";
import type { Dirent } from "fs";
import type {
  HarnessId,
  HarnessObservedPeriod,
  AttemptCostSource,
} from "../../../../types/DashboardConstants";
import {
  ATTEMPT_COST_SOURCES,
  HARNESS_IDS,
  HARNESS_OBSERVED_PERIODS,
  RUN_HISTORY_LOCATIONS,
  WORKFLOW_TOKEN_COVERAGE,
} from "../../../../types/DashboardConstants";
import type { HarnessObservedTokens } from "../../../../types/UsageTypes";
import type {
  RunRef,
  WorkflowHarnessTokenTotals,
  WorkflowKey,
  WorkflowTokenTotals,
} from "../../../../types/CtrlYokeTypes";
import { renameWithTransientRetry } from "../../../../utils/AtomicFileUtils";
import { withFileLock } from "../../../../utils/FileLockUtils";
import { getFrozenRunHistoryLocation } from "../../../../utils/RunHistoryStoragePolicy";
import { userProjectsRoot } from "../../../../utils/ProjectStatePaths";
import {
  observedUsagePath,
  observedUsagePathForProject,
} from "../../../../utils/UsagePaths";

export const OBSERVED_USAGE_SCHEMA_VERSION = 1 as const;

export const OBSERVED_USAGE_ERROR_CODES = {
  MALFORMED_DATA: "malformed-observed-usage-data",
  WRITE_FAILED: "observed-usage-write-failed",
} as const;

type UsageNumbers = Omit<HarnessObservedTokens, "since">;

export type ObservedHarnessUsageDayContribution = UsageNumbers;

export interface ObservedHarnessUsageRunContribution {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  updatedAt: number;
  byLocalDay: Record<
    string,
    Partial<Record<HarnessId, ObservedHarnessUsageDayContribution>>
  >;
}

export interface ObservedHarnessUsageBuckets {
  daily: Record<string, Partial<Record<HarnessId, HarnessObservedTokens>>>;
  weekly: Record<string, Partial<Record<HarnessId, HarnessObservedTokens>>>;
  monthly: Record<string, Partial<Record<HarnessId, HarnessObservedTokens>>>;
}

export interface ObservedHarnessUsageStoreData {
  schemaVersion: typeof OBSERVED_USAGE_SCHEMA_VERSION;
  updatedAt: number;
  runs: Record<string, ObservedHarnessUsageRunContribution>;
  buckets: ObservedHarnessUsageBuckets;
}

const EMPTY_BUCKETS = (): ObservedHarnessUsageBuckets => ({
  daily: {},
  weekly: {},
  monthly: {},
});
const VALID_HARNESS_IDS = new Set(Object.values(HARNESS_IDS));

function emptyStore(now: number): ObservedHarnessUsageStoreData {
  return {
    schemaVersion: OBSERVED_USAGE_SCHEMA_VERSION,
    updatedAt: now,
    runs: {},
    buckets: EMPTY_BUCKETS(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocalDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function localMidnight(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

function addDays(dayKey: string, days: number): string {
  const date = new Date(localMidnight(dayKey));
  date.setDate(date.getDate() + days);
  return formatLocalDay(date);
}

function formatLocalDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isoWeekStart(dayKey: string): string {
  const date = new Date(localMidnight(dayKey));
  const mondayOffset = date.getDay() === 0 ? 6 : date.getDay() - 1;
  return addDays(dayKey, -mondayOffset);
}

function monthStart(dayKey: string): string {
  return `${dayKey.slice(0, 7)}-01`;
}

function retainedDayStart(now: number): string {
  const today = formatLocalDay(new Date(now));
  const month = monthStart(today);
  const week = isoWeekStart(today);
  return [today, month, week].sort()[0]!;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function optionalNumeric(value: unknown): number | undefined {
  const result = numeric(value);
  return result > 0 ? result : undefined;
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

function addUsage(
  left: UsageNumbers | undefined,
  right: UsageNumbers,
  sign: 1 | -1
): UsageNumbers {
  const current = left ?? {
    input: 0,
    output: 0,
    total: 0,
  };
  const result: UsageNumbers = {
    input: Math.max(0, numeric(current.input) + sign * numeric(right.input)),
    output: Math.max(0, numeric(current.output) + sign * numeric(right.output)),
    total: Math.max(0, numeric(current.total) + sign * numeric(right.total)),
  };
  const cachedInput = Math.max(
    0,
    numeric(current.cachedInput) + sign * numeric(right.cachedInput)
  );
  const cacheCreated = Math.max(
    0,
    numeric(current.cacheCreated) + sign * numeric(right.cacheCreated)
  );
  const reasoningOutput = Math.max(
    0,
    numeric(current.reasoningOutput) + sign * numeric(right.reasoningOutput)
  );
  const costUsd = Math.max(
    0,
    numeric(current.costUsd) + sign * numeric(right.costUsd)
  );
  if (cachedInput > 0) result.cachedInput = cachedInput;
  if (cacheCreated > 0) result.cacheCreated = cacheCreated;
  if (reasoningOutput > 0) result.reasoningOutput = reasoningOutput;
  if (costUsd > 0) result.costUsd = costUsd;
  if (sign === 1) {
    result.costSources = stableCostSources([
      ...(current.costSources ?? []),
      ...(right.costSources ?? []),
    ]);
    result.costPartial =
      current.costPartial === true || right.costPartial === true;
    result.partial = current.partial === true || right.partial === true;
  } else {
    result.costSources = stableCostSources(current.costSources);
    result.costPartial = current.costPartial;
    result.partial = current.partial;
  }
  return result;
}

function toContribution(
  totals: WorkflowHarnessTokenTotals
): ObservedHarnessUsageDayContribution {
  return {
    input: numeric(totals.input),
    ...(optionalNumeric(totals.cachedInput) !== undefined
      ? { cachedInput: optionalNumeric(totals.cachedInput) }
      : {}),
    ...(optionalNumeric(totals.cacheCreated) !== undefined
      ? { cacheCreated: optionalNumeric(totals.cacheCreated) }
      : {}),
    output: numeric(totals.output),
    ...(optionalNumeric(totals.reasoningOutput) !== undefined
      ? { reasoningOutput: optionalNumeric(totals.reasoningOutput) }
      : {}),
    total: numeric(totals.total),
    ...(optionalNumeric(totals.costUsd) !== undefined
      ? { costUsd: optionalNumeric(totals.costUsd) }
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

function normalizeContribution(
  workflowKey: WorkflowKey,
  runRef: RunRef,
  totals: WorkflowTokenTotals | undefined,
  now: number
): ObservedHarnessUsageRunContribution {
  const byLocalDay: ObservedHarnessUsageRunContribution["byLocalDay"] = {};
  const latestDay = formatLocalDay(new Date(now));
  const firstRetainedDay = retainedDayStart(now);
  for (const [dayKey, harnesses] of Object.entries(totals?.byLocalDay ?? {})) {
    if (
      !isLocalDayKey(dayKey) ||
      dayKey < firstRetainedDay ||
      dayKey > latestDay
    ) {
      continue;
    }
    if (!isRecord(harnesses)) continue;
    const normalizedHarnesses: Partial<
      Record<HarnessId, ObservedHarnessUsageDayContribution>
    > = {};
    for (const [harnessId, subtotal] of Object.entries(harnesses)) {
      if (!VALID_HARNESS_IDS.has(harnessId as HarnessId)) continue;
      if (!isRecord(subtotal)) continue;
      const contribution = toContribution(
        subtotal as WorkflowHarnessTokenTotals
      );
      if (
        contribution.total > 0 ||
        contribution.input > 0 ||
        contribution.output > 0
      ) {
        normalizedHarnesses[harnessId as HarnessId] = contribution;
      }
    }
    if (Object.keys(normalizedHarnesses).length > 0) {
      byLocalDay[dayKey] = normalizedHarnesses;
    }
  }
  return { workflowKey, runRef, updatedAt: now, byLocalDay };
}

function bucketFor(
  buckets: ObservedHarnessUsageBuckets,
  period: HarnessObservedPeriod
): Record<string, Partial<Record<HarnessId, HarnessObservedTokens>>> {
  return buckets[period];
}

function applyContribution(
  buckets: ObservedHarnessUsageBuckets,
  contribution: ObservedHarnessUsageRunContribution,
  sign: 1 | -1
): void {
  for (const [dayKey, harnesses] of Object.entries(contribution.byLocalDay)) {
    const periods: readonly [HarnessObservedPeriod, string, number][] = [
      [HARNESS_OBSERVED_PERIODS.DAILY, dayKey, localMidnight(dayKey)],
      [
        HARNESS_OBSERVED_PERIODS.WEEKLY,
        isoWeekStart(dayKey),
        localMidnight(isoWeekStart(dayKey)),
      ],
      [
        HARNESS_OBSERVED_PERIODS.MONTHLY,
        monthStart(dayKey),
        localMidnight(monthStart(dayKey)),
      ],
    ];
    for (const [period, bucketKey, since] of periods) {
      const bucket = bucketFor(buckets, period);
      const existing = bucket[bucketKey] ?? {};
      for (const [harnessId, values] of Object.entries(harnesses)) {
        if (!values) continue;
        const updated = addUsage(
          existing[harnessId as HarnessId],
          values,
          sign
        );
        if (
          updated.total === 0 &&
          updated.input === 0 &&
          updated.output === 0
        ) {
          delete existing[harnessId as HarnessId];
        } else {
          existing[harnessId as HarnessId] = {
            ...updated,
            since,
          };
        }
      }
      if (Object.keys(existing).length > 0) bucket[bucketKey] = existing;
      else delete bucket[bucketKey];
    }
  }
}

function pruneStore(data: ObservedHarnessUsageStoreData, now: number): void {
  const firstRetainedDay = retainedDayStart(now);
  for (const [runKey, contribution] of Object.entries(data.runs)) {
    const retainedDays = Object.fromEntries(
      Object.entries(contribution.byLocalDay).filter(
        ([dayKey]) => dayKey >= firstRetainedDay
      )
    );
    if (Object.keys(retainedDays).length === 0) {
      applyContribution(data.buckets, contribution, -1);
      delete data.runs[runKey];
    } else if (
      Object.keys(retainedDays).length !==
      Object.keys(contribution.byLocalDay).length
    ) {
      const pruned = { ...contribution, byLocalDay: retainedDays };
      applyContribution(data.buckets, contribution, -1);
      applyContribution(data.buckets, pruned, 1);
      data.runs[runKey] = pruned;
    }
  }
  for (const period of Object.values(HARNESS_OBSERVED_PERIODS)) {
    const bucket = bucketFor(data.buckets, period);
    for (const key of Object.keys(bucket)) {
      if (key < firstRetainedDay) delete bucket[key];
    }
  }
}

function rebuildBuckets(data: ObservedHarnessUsageStoreData): void {
  data.buckets = EMPTY_BUCKETS();
  for (const contribution of Object.values(data.runs)) {
    applyContribution(data.buckets, contribution, 1);
  }
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidObservedTokens(value: unknown): value is HarnessObservedTokens {
  if (!isRecord(value)) return false;
  if (
    !isFiniteNonNegative(value.input) ||
    !isFiniteNonNegative(value.output) ||
    !isFiniteNonNegative(value.total) ||
    !isFiniteNonNegative(value.since)
  ) {
    return false;
  }
  for (const key of [
    "cachedInput",
    "cacheCreated",
    "reasoningOutput",
    "costUsd",
  ]) {
    if (key in value && !isFiniteNonNegative(value[key])) return false;
  }
  if ("costPartial" in value && typeof value.costPartial !== "boolean") {
    return false;
  }
  if ("partial" in value && typeof value.partial !== "boolean") {
    return false;
  }
  if (
    "costSources" in value &&
    (!Array.isArray(value.costSources) ||
      value.costSources.some(
        (source) =>
          !Object.values(ATTEMPT_COST_SOURCES).includes(
            source as AttemptCostSource
          )
      ))
  ) {
    return false;
  }
  return true;
}

function validateBucketsForRollup(buckets: ObservedHarnessUsageBuckets): void {
  for (const period of Object.values(HARNESS_OBSERVED_PERIODS)) {
    for (const [bucketKey, harnesses] of Object.entries(buckets[period])) {
      if (!isLocalDayKey(bucketKey) || !isRecord(harnesses)) {
        throw new Error(OBSERVED_USAGE_ERROR_CODES.MALFORMED_DATA);
      }
      for (const [harnessId, values] of Object.entries(harnesses)) {
        if (
          !VALID_HARNESS_IDS.has(harnessId as HarnessId) ||
          !isValidObservedTokens(values)
        ) {
          throw new Error(OBSERVED_USAGE_ERROR_CODES.MALFORMED_DATA);
        }
      }
    }
  }
}

function mergeBuckets(
  target: ObservedHarnessUsageBuckets,
  source: ObservedHarnessUsageBuckets
): void {
  for (const period of Object.values(HARNESS_OBSERVED_PERIODS)) {
    for (const [bucketKey, harnesses] of Object.entries(source[period])) {
      const targetBucket = target[period][bucketKey] ?? {};
      for (const [harnessId, values] of Object.entries(harnesses)) {
        if (!values) continue;
        const current = targetBucket[harnessId as HarnessId];
        targetBucket[harnessId as HarnessId] = {
          ...addUsage(current, values, 1),
          since: current?.since ?? values.since,
        };
      }
      if (Object.keys(targetBucket).length > 0) {
        target[period][bucketKey] = targetBucket;
      }
    }
  }
}

async function readProjectUsageBuckets(
  filePath: string
): Promise<ObservedHarnessUsageBuckets | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = validateStore(JSON.parse(raw));
    validateBucketsForRollup(data.buckets);
    return data.buckets;
  } catch {
    return undefined;
  }
}

async function foldProjectUsageBuckets(): Promise<ObservedHarnessUsageBuckets> {
  const buckets = EMPTY_BUCKETS();
  const projectsRoot = userProjectsRoot();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return buckets;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectBuckets = await readProjectUsageBuckets(
      observedUsagePathForProject(path.join(projectsRoot, entry.name))
    );
    if (projectBuckets) mergeBuckets(buckets, projectBuckets);
  }
  return buckets;
}

function validateStore(value: unknown): ObservedHarnessUsageStoreData {
  if (
    !isRecord(value) ||
    value.schemaVersion !== OBSERVED_USAGE_SCHEMA_VERSION
  ) {
    throw new Error(OBSERVED_USAGE_ERROR_CODES.MALFORMED_DATA);
  }
  if (!isRecord(value.runs) || !isRecord(value.buckets)) {
    throw new Error(OBSERVED_USAGE_ERROR_CODES.MALFORMED_DATA);
  }
  if (
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt)
  ) {
    throw new Error(OBSERVED_USAGE_ERROR_CODES.MALFORMED_DATA);
  }
  for (const contribution of Object.values(value.runs)) {
    if (
      !isRecord(contribution) ||
      typeof contribution.workflowKey !== "string" ||
      typeof contribution.runRef !== "string" ||
      typeof contribution.updatedAt !== "number" ||
      !isRecord(contribution.byLocalDay)
    ) {
      throw new Error(OBSERVED_USAGE_ERROR_CODES.MALFORMED_DATA);
    }
    for (const [dayKey, harnesses] of Object.entries(contribution.byLocalDay)) {
      if (!isLocalDayKey(dayKey) || !isRecord(harnesses)) {
        throw new Error(OBSERVED_USAGE_ERROR_CODES.MALFORMED_DATA);
      }
      for (const [harnessId, values] of Object.entries(harnesses)) {
        if (
          !VALID_HARNESS_IDS.has(harnessId as HarnessId) ||
          !isRecord(values)
        ) {
          throw new Error(OBSERVED_USAGE_ERROR_CODES.MALFORMED_DATA);
        }
      }
    }
  }
  const buckets = value.buckets;
  for (const period of Object.values(HARNESS_OBSERVED_PERIODS)) {
    if (!isRecord(buckets[period])) {
      throw new Error(OBSERVED_USAGE_ERROR_CODES.MALFORMED_DATA);
    }
  }
  return value as unknown as ObservedHarnessUsageStoreData;
}

export class ObservedHarnessUsageStore {
  private readonly filePath: string;
  private lastErrorCode: string | undefined;

  constructor(workspaceRoot: string) {
    this.filePath = observedUsagePath(workspaceRoot);
  }

  getPath(): string {
    return this.filePath;
  }

  getLastErrorCode(): string | undefined {
    return this.lastErrorCode;
  }

  async read(now: number = Date.now()): Promise<ObservedHarnessUsageStoreData> {
    return withFileLock(this.filePath, async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const data = await this.readOrReset(now);
      pruneStore(data, now);
      rebuildBuckets(data);
      data.updatedAt = now;
      await this.writeAtomic(data);
      return data;
    });
  }

  /** Read the buckets used by the dashboard, folding user-scoped projects. */
  async readForDisplay(
    now: number = Date.now()
  ): Promise<ObservedHarnessUsageBuckets> {
    if (getFrozenRunHistoryLocation() === RUN_HISTORY_LOCATIONS.WORKSPACE) {
      return (await this.read(now)).buckets;
    }
    return foldProjectUsageBuckets();
  }

  async upsertRunContribution(
    workflowKey: WorkflowKey,
    runRef: RunRef,
    tokenTotals: WorkflowTokenTotals | undefined,
    now: number = Date.now()
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await withFileLock(this.filePath, async () => {
        const data = await this.readOrReset(now);
        pruneStore(data, now);
        const runKey = `${workflowKey}/${runRef}`;
        const replacement = normalizeContribution(
          workflowKey,
          runRef,
          tokenTotals,
          now
        );
        const previous = data.runs[runKey];
        if (previous && previous.updatedAt > replacement.updatedAt) {
          return;
        }
        if (Object.keys(replacement.byLocalDay).length > 0) {
          data.runs[runKey] = replacement;
        } else {
          delete data.runs[runKey];
        }
        data.updatedAt = now;
        pruneStore(data, now);
        rebuildBuckets(data);
        await this.writeAtomic(data);
      });
    } catch (error) {
      const wrapped = new Error(OBSERVED_USAGE_ERROR_CODES.WRITE_FAILED);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  private async readOrReset(
    now: number
  ): Promise<ObservedHarnessUsageStoreData> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return validateStore(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptyStore(now);
      this.lastErrorCode = OBSERVED_USAGE_ERROR_CODES.MALFORMED_DATA;
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

  private async writeAtomic(
    data: ObservedHarnessUsageStoreData
  ): Promise<void> {
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
