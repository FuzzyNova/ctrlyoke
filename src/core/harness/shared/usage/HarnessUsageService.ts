import * as fs from "fs/promises";
import * as path from "path";
import {
  HARNESS_IDS,
  HARNESS_OBSERVED_PERIODS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_REFRESH_DEBOUNCE_MS,
  type HarnessObservedPeriod,
  type HarnessId,
} from "../../../../types/DashboardConstants";
import type {
  HarnessObservedTokens,
  HarnessQuotaSnapshot,
  HarnessUsageSnapshot,
  HarnessUsageWindow,
} from "../../../../types/UsageTypes";
import {
  defaultStaleAfterMs,
  isHarnessQuotaStale,
} from "../../../../types/UsageTypes";
import { withFileLock } from "../../../../utils/FileLockUtils";
import { providerSnapshotsPath } from "../../../../utils/UsagePaths";
import { normalizeUsageTimestamp } from "./UsageTimestampUtils";
import { ObservedHarnessUsageStore } from "./ObservedHarnessUsageStore";
import type { IHarnessUsageProvider } from "./IHarnessUsageProvider";
import { createDefaultHarnessUsageProviders } from "./providers";

export const PROVIDER_USAGE_SCHEMA_VERSION = 1 as const;

export const HARNESS_USAGE_ERROR_CODES = {
  MALFORMED_PROVIDER_DATA: "malformed-provider-usage-data",
  PROVIDER_REFRESH_FAILED: "provider-refresh-failed",
  PROVIDER_USAGE_WRITE_FAILED: "provider-usage-write-failed",
} as const;

export interface HarnessUsageUpdateSink {
  updateHarnessUsage(snapshots: HarnessUsageSnapshot[]): void;
}

interface PersistedProviderUsage {
  schemaVersion: typeof PROVIDER_USAGE_SCHEMA_VERSION;
  snapshots: Partial<Record<HarnessId, HarnessQuotaSnapshot>>;
}

const HARNESS_ID_LIST = Object.values(HARNESS_IDS) as HarnessId[];
const VALID_HARNESS_IDS = new Set<HarnessId>(HARNESS_ID_LIST);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addLocalDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function observedSince(period: HarnessObservedPeriod, now: number): number {
  const date = new Date(now);
  if (period === HARNESS_OBSERVED_PERIODS.DAILY) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }
  if (period === HARNESS_OBSERVED_PERIODS.MONTHLY) {
    return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  }
  const mondayOffset = date.getDay() === 0 ? 6 : date.getDay() - 1;
  const monday = addLocalDays(
    new Date(date.getFullYear(), date.getMonth(), date.getDate()),
    -mondayOffset
  );
  return monday.getTime();
}

function observedKey(period: HarnessObservedPeriod, now: number): string {
  const date = new Date(observedSince(period, now));
  return localDayKey(date);
}

function emptyObserved(period: HarnessObservedPeriod, now: number): HarnessObservedTokens {
  return {
    input: 0,
    output: 0,
    total: 0,
    since: observedSince(period, now),
  };
}

function cloneQuota(quota: HarnessQuotaSnapshot): HarnessQuotaSnapshot {
  return {
    ...quota,
    windows: quota.windows.map((window) => ({ ...window })),
  };
}

function normalizeWindow(window: HarnessUsageWindow): HarnessUsageWindow {
  return {
    ...window,
    ...(window.resetAt !== undefined
      ? { resetAt: normalizeUsageTimestamp(window.resetAt) }
      : {}),
  };
}

function normalizeQuota(quota: HarnessQuotaSnapshot): HarnessQuotaSnapshot {
  const source = Object.values(HARNESS_QUOTA_SOURCES).includes(quota.source)
    ? quota.source
    : HARNESS_QUOTA_SOURCES.UNAVAILABLE;
  const staleAfterMs =
    quota.staleAfterMs > 0 ? quota.staleAfterMs : defaultStaleAfterMs(source);
  return {
    harnessId: quota.harnessId,
    source,
    ...(quota.fetchedAt !== undefined
      ? { fetchedAt: normalizeUsageTimestamp(quota.fetchedAt) }
      : {}),
    staleAfterMs,
    windows: quota.windows.map(normalizeWindow),
    ...(quota.planType ? { planType: quota.planType } : {}),
    ...(quota.errorCode ? { errorCode: quota.errorCode } : {}),
  };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.message === HARNESS_USAGE_ERROR_CODES.MALFORMED_PROVIDER_DATA) {
    return error.message;
  }
  return HARNESS_USAGE_ERROR_CODES.PROVIDER_REFRESH_FAILED;
}

export class HarnessUsageService {
  private readonly providerByHarness = new Map<HarnessId, IHarnessUsageProvider>();
  private readonly quotaCache = new Map<HarnessId, HarnessQuotaSnapshot>();
  private readonly observedCache = new Map<HarnessId, HarnessUsageSnapshot["observed"]>();
  private readonly refreshPromises = new Map<HarnessId, Promise<HarnessUsageSnapshot>>();
  private readonly refreshTimers = new Map<HarnessId, ReturnType<typeof setTimeout>>();
  private readonly providerSnapshotsFile: string;
  private readonly observedStore: ObservedHarnessUsageStore;
  private readonly emit?: (snapshots: HarnessUsageSnapshot[]) => void;
  private readonly now: () => number;
  private readonly persistedLoad: Promise<void>;

  constructor(
    workspaceRoot: string,
    providers: readonly IHarnessUsageProvider[] = createDefaultHarnessUsageProviders(),
    observedStore: ObservedHarnessUsageStore = new ObservedHarnessUsageStore(workspaceRoot),
    emit?: (snapshots: HarnessUsageSnapshot[]) => void,
    now: () => number = Date.now
  ) {
    this.providerSnapshotsFile = providerSnapshotsPath(workspaceRoot);
    this.observedStore = observedStore;
    this.emit = emit;
    this.now = now;
    for (const provider of providers) {
      if (VALID_HARNESS_IDS.has(provider.harnessId)) {
        this.providerByHarness.set(provider.harnessId, provider);
      }
    }
    for (const harnessId of HARNESS_ID_LIST) {
      this.quotaCache.set(harnessId, this.createUnavailableQuota(harnessId));
    }
    this.persistedLoad = this.loadPersistedProviderSnapshots();
  }

  /** Load normalized last-known windows without making a provider call. */
  async initialize(): Promise<void> {
    await this.persistedLoad;
    await this.refreshObservedUsage();
  }

  getHarnessUsage(harnessId: HarnessId): HarnessUsageSnapshot {
    return this.buildSnapshot(harnessId);
  }

  getHarnessUsageSnapshots(): HarnessUsageSnapshot[] {
    return HARNESS_ID_LIST.map((harnessId) => this.buildSnapshot(harnessId));
  }

  /** Injected push port for parsers and sidecars. */
  ingestProviderUsage(quota: HarnessQuotaSnapshot): void {
    if (!VALID_HARNESS_IDS.has(quota.harnessId)) return;
    const normalized = normalizeQuota(quota);
    this.quotaCache.set(quota.harnessId, normalized);
    this.publish();
    void this.persistProviderSnapshots();
  }

  getProviderUsageIngestPort(): (quota: HarnessQuotaSnapshot) => void {
    return (quota) => this.ingestProviderUsage(quota);
  }

  refreshHarnessUsage(harnessId: HarnessId): Promise<HarnessUsageSnapshot> {
    const existing = this.refreshPromises.get(harnessId);
    if (existing) return existing;
    const promise = new Promise<HarnessUsageSnapshot>((resolve) => {
      const timer = setTimeout(() => {
        this.refreshTimers.delete(harnessId);
        void this.refreshOne(harnessId).then(resolve);
      }, HARNESS_USAGE_REFRESH_DEBOUNCE_MS);
      this.refreshTimers.set(harnessId, timer);
    }).finally(() => {
      this.refreshPromises.delete(harnessId);
    });
    this.refreshPromises.set(harnessId, promise);
    return promise;
  }

  async refreshAllHarnessUsage(): Promise<HarnessUsageSnapshot[]> {
    await Promise.all(HARNESS_ID_LIST.map((harnessId) => this.refreshHarnessUsage(harnessId)));
    return this.getHarnessUsageSnapshots();
  }

  isQuotaStale(harnessId: HarnessId, now: number = this.now()): boolean {
    return isHarnessQuotaStale(this.quotaCache.get(harnessId) ?? this.createUnavailableQuota(harnessId), now);
  }

  private async refreshOne(harnessId: HarnessId): Promise<HarnessUsageSnapshot> {
    await this.refreshObservedUsage();
    const provider = this.providerByHarness.get(harnessId);
    if (!provider) {
      this.quotaCache.set(harnessId, this.createUnavailableQuota(harnessId, "provider-not-registered"));
    } else {
      try {
        const quota = await provider.refreshUsage();
        if (quota.harnessId !== harnessId) {
          throw new Error(HARNESS_USAGE_ERROR_CODES.MALFORMED_PROVIDER_DATA);
        }
        this.ingestProviderUsage(quota);
      } catch (error) {
        const previous = this.quotaCache.get(harnessId);
        this.quotaCache.set(
          harnessId,
          previous && previous.fetchedAt !== undefined
            ? { ...previous, errorCode: safeErrorCode(error) }
            : this.createUnavailableQuota(harnessId, safeErrorCode(error))
        );
      }
    }
    this.publish();
    return this.buildSnapshot(harnessId);
  }

  private async refreshObservedUsage(): Promise<void> {
    try {
      const data = await this.observedStore.read(this.now());
      const now = this.now();
      const observedErrorCode = this.observedStore.getLastErrorCode();
      for (const harnessId of HARNESS_ID_LIST) {
        const observed: HarnessUsageSnapshot["observed"] = {};
        for (const period of Object.values(HARNESS_OBSERVED_PERIODS)) {
          observed[period] =
            data.buckets[period][observedKey(period, now)]?.[harnessId] ??
            emptyObserved(period, now);
        }
        if (observedErrorCode && !this.quotaCache.get(harnessId)?.errorCode) {
          const quota = this.quotaCache.get(harnessId);
          if (quota) {
            this.quotaCache.set(harnessId, {
              ...quota,
              errorCode: observedErrorCode,
            });
          }
        }
        this.observedCache.set(harnessId, observed);
      }
    } catch {
      // Observed usage is advisory and must never block execution or refresh.
    }
  }

  private buildSnapshot(harnessId: HarnessId): HarnessUsageSnapshot {
    return {
      harnessId,
      updatedAt: this.now(),
      quota: cloneQuota(this.quotaCache.get(harnessId) ?? this.createUnavailableQuota(harnessId)),
      observed: this.observedCache.get(harnessId) ?? this.emptyObservedPeriods(),
    };
  }

  private emptyObservedPeriods(): HarnessUsageSnapshot["observed"] {
    const now = this.now();
    return Object.fromEntries(
      Object.values(HARNESS_OBSERVED_PERIODS).map((period) => [period, emptyObserved(period, now)])
    ) as HarnessUsageSnapshot["observed"];
  }

  private createUnavailableQuota(harnessId: HarnessId, errorCode?: string): HarnessQuotaSnapshot {
    return {
      harnessId,
      source: HARNESS_QUOTA_SOURCES.UNAVAILABLE,
      staleAfterMs: 0,
      windows: [],
      ...(errorCode ? { errorCode } : {}),
    };
  }

  private publish(): void {
    this.emit?.(this.getHarnessUsageSnapshots());
  }

  private async loadPersistedProviderSnapshots(): Promise<void> {
    try {
      const raw = await fs.readFile(this.providerSnapshotsFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.schemaVersion !== PROVIDER_USAGE_SCHEMA_VERSION || !isRecord(parsed.snapshots)) {
        throw new Error(HARNESS_USAGE_ERROR_CODES.MALFORMED_PROVIDER_DATA);
      }
      for (const [harnessId, value] of Object.entries(parsed.snapshots)) {
        if (VALID_HARNESS_IDS.has(harnessId as HarnessId) && isRecord(value)) {
          const quota = value as unknown as HarnessQuotaSnapshot;
          if (Array.isArray(quota.windows) && typeof quota.source === "string") {
            this.quotaCache.set(harnessId as HarnessId, normalizeQuota(quota));
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await this.quarantineProviderSnapshotFile();
    }
  }

  private async persistProviderSnapshots(): Promise<void> {
    try {
      await withFileLock(this.providerSnapshotsFile, async () => {
        await fs.mkdir(path.dirname(this.providerSnapshotsFile), { recursive: true });
        const snapshots: Partial<Record<HarnessId, HarnessQuotaSnapshot>> = {};
        for (const harnessId of HARNESS_ID_LIST) {
          const quota = this.quotaCache.get(harnessId);
          if (quota?.fetchedAt !== undefined) {
            snapshots[harnessId] = {
              ...cloneQuota(quota),
              message: undefined,
            };
          }
        }
        const data: PersistedProviderUsage = {
          schemaVersion: PROVIDER_USAGE_SCHEMA_VERSION,
          snapshots,
        };
        const tempPath = `${this.providerSnapshotsFile}.${process.pid}.${this.now()}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
        await fs.rename(tempPath, this.providerSnapshotsFile);
      });
    } catch {
      // Provider persistence is best effort and never affects execution.
    }
  }

  private async quarantineProviderSnapshotFile(): Promise<void> {
    await fs
      .rename(this.providerSnapshotsFile, `${this.providerSnapshotsFile}.corrupt-${this.now()}.json`)
      .catch(() => undefined);
  }
}
