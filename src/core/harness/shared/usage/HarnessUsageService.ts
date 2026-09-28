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
import { defaultStaleAfterMs } from "../../../../types/UsageTypes";
import { renameWithTransientRetry } from "../../../../utils/AtomicFileUtils";
import { getErrorMessage } from "../../../../utils/ErrorUtils";
import { withFileLock } from "../../../../utils/FileLockUtils";
import { Log } from "../../../../utils/Log";
import { providerSnapshotsPath } from "../../../../utils/UsagePaths";
import {
  assertWritableSchema,
  CURRENT_SCHEMA_VERSIONS,
  isNewerSchemaError,
  PERSISTED_STORES,
} from "../../../../utils/PersistedSchemaGuard";
import { migrateToCurrent } from "../../../../utils/FormatMigrations";
import { normalizeUsageTimestamp } from "./UsageTimestampUtils";
import { ObservedHarnessUsageStore } from "./ObservedHarnessUsageStore";
import type { IHarnessUsageProvider } from "./IHarnessUsageProvider";
import { createDefaultHarnessUsageProviders } from "./providers";

export const PROVIDER_USAGE_SCHEMA_VERSION =
  CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.PROVIDER_USAGE];

export const HARNESS_USAGE_ERROR_CODES = {
  MALFORMED_PROVIDER_DATA: "malformed-provider-usage-data",
  PROVIDER_REFRESH_FAILED: "provider-refresh-failed",
  PROVIDER_USAGE_WRITE_FAILED: "provider-usage-write-failed",
} as const;

export interface HarnessUsageUpdateSink {
  updateHarnessUsage(snapshots: HarnessUsageSnapshot[]): void;
}

export interface HarnessUsageServiceOptions {
  isEnabled?: () => boolean;
  isProviderRefreshEnabled?: () => boolean;
  shouldPersistObservedUsage?: () => boolean;
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
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate()
    ).getTime();
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

function emptyObserved(
  period: HarnessObservedPeriod,
  now: number
): HarnessObservedTokens {
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
  if (
    error instanceof Error &&
    error.message === HARNESS_USAGE_ERROR_CODES.MALFORMED_PROVIDER_DATA
  ) {
    return error.message;
  }
  return HARNESS_USAGE_ERROR_CODES.PROVIDER_REFRESH_FAILED;
}

export class HarnessUsageService {
  private readonly providerByHarness = new Map<
    HarnessId,
    IHarnessUsageProvider
  >();
  private readonly quotaCache = new Map<HarnessId, HarnessQuotaSnapshot>();
  private readonly observedCache = new Map<
    HarnessId,
    HarnessUsageSnapshot["observed"]
  >();
  private readonly refreshPromises = new Map<
    HarnessId,
    Promise<HarnessUsageSnapshot>
  >();
  private readonly refreshTimers = new Map<
    HarnessId,
    ReturnType<typeof setTimeout>
  >();
  /**
   * Abort handles for provider probes that are currently running. Providers may
   * own a short-lived subprocess (Copilot's quota RPC, Codex's app-server), so
   * host teardown has to be able to cancel them rather than leave a child
   * running past extension deactivation.
   */
  private readonly inFlightProbes = new Set<AbortController>();
  private disposed = false;
  private readonly providerSnapshotsFile: string;
  private readonly observedStore: ObservedHarnessUsageStore;
  private readonly emit?: (snapshots: HarnessUsageSnapshot[]) => void;
  private readonly now: () => number;
  private readonly options: Required<HarnessUsageServiceOptions>;
  private readonly persistedLoad: Promise<void>;

  constructor(
    workspaceRoot: string,
    providers: readonly IHarnessUsageProvider[] = createDefaultHarnessUsageProviders(),
    observedStore: ObservedHarnessUsageStore = new ObservedHarnessUsageStore(
      workspaceRoot
    ),
    emit?: (snapshots: HarnessUsageSnapshot[]) => void,
    now: () => number = Date.now,
    options: HarnessUsageServiceOptions = {}
  ) {
    this.providerSnapshotsFile = providerSnapshotsPath();
    this.observedStore = observedStore;
    this.emit = emit;
    this.now = now;
    this.options = {
      isEnabled: options.isEnabled ?? (() => true),
      isProviderRefreshEnabled:
        options.isProviderRefreshEnabled ?? (() => true),
      shouldPersistObservedUsage:
        options.shouldPersistObservedUsage ?? (() => true),
    };
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
    if (this.options.isEnabled() && this.options.shouldPersistObservedUsage()) {
      await this.refreshObservedUsage();
    }
  }

  getHarnessUsage(harnessId: HarnessId): HarnessUsageSnapshot {
    return this.buildSnapshot(harnessId);
  }

  getHarnessUsageSnapshots(): HarnessUsageSnapshot[] {
    return HARNESS_ID_LIST.map((harnessId) => this.buildSnapshot(harnessId));
  }

  /** Injected push port for parsers and sidecars. */
  ingestProviderUsage(quota: HarnessQuotaSnapshot): void {
    if (!this.options.isEnabled()) return;
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
    if (
      this.disposed ||
      !this.options.isEnabled() ||
      !this.options.isProviderRefreshEnabled()
    ) {
      return Promise.resolve(this.buildSnapshot(harnessId));
    }
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
    if (!this.options.isEnabled() || !this.options.isProviderRefreshEnabled()) {
      return this.getHarnessUsageSnapshots();
    }
    await Promise.all(
      HARNESS_ID_LIST.map((harnessId) => this.refreshHarnessUsage(harnessId))
    );
    return this.getHarnessUsageSnapshots();
  }

  /**
   * Cancel every pending and in-flight provider refresh. Called on host
   * teardown so a provider subprocess cannot outlive the extension; already
   * cached snapshots stay readable, and later refresh requests are no-ops.
   */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    for (const probe of this.inFlightProbes) {
      probe.abort();
    }
    this.inFlightProbes.clear();
  }

  private async refreshOne(
    harnessId: HarnessId
  ): Promise<HarnessUsageSnapshot> {
    if (this.options.shouldPersistObservedUsage()) {
      await this.refreshObservedUsage();
    }
    const provider = this.providerByHarness.get(harnessId);
    if (!provider) {
      this.quotaCache.set(
        harnessId,
        this.createUnavailableQuota(harnessId, "provider-not-registered")
      );
    } else {
      const probe = new AbortController();
      this.inFlightProbes.add(probe);
      try {
        const quota = await provider.refreshUsage(probe.signal);
        if (quota.harnessId !== harnessId) {
          throw new Error(HARNESS_USAGE_ERROR_CODES.MALFORMED_PROVIDER_DATA);
        }
        // A provider may have no safe standalone probe (Claude's live quota is
        // pushed by its statusline sidecar). Do not erase a last-known live
        // snapshot merely because a pull refresh has no new data.
        if (
          quota.source !== HARNESS_QUOTA_SOURCES.UNAVAILABLE ||
          quota.windows.length > 0 ||
          quota.fetchedAt !== undefined
        ) {
          this.ingestProviderUsage(quota);
        } else if (quota.errorCode) {
          // Preserve a last-known quota while surfacing a safe capability/auth
          // status from a non-blocking probe. With no prior quota, retain the
          // unavailable status so the dashboard can distinguish it from a
          // successful empty response.
          const previous = this.quotaCache.get(harnessId);
          this.quotaCache.set(
            harnessId,
            previous?.fetchedAt !== undefined
              ? { ...previous, errorCode: quota.errorCode }
              : normalizeQuota(quota)
          );
        }
      } catch (error) {
        const previous = this.quotaCache.get(harnessId);
        this.quotaCache.set(
          harnessId,
          previous && previous.fetchedAt !== undefined
            ? { ...previous, errorCode: safeErrorCode(error) }
            : this.createUnavailableQuota(harnessId, safeErrorCode(error))
        );
      } finally {
        this.inFlightProbes.delete(probe);
      }
    }
    this.publish();
    return this.buildSnapshot(harnessId);
  }

  private async refreshObservedUsage(): Promise<void> {
    try {
      const buckets = await this.observedStore.readForDisplay(this.now());
      const now = this.now();
      const observedErrorCode = this.observedStore.getLastErrorCode();
      for (const harnessId of HARNESS_ID_LIST) {
        const observed: HarnessUsageSnapshot["observed"] = {};
        for (const period of Object.values(HARNESS_OBSERVED_PERIODS)) {
          observed[period] =
            buckets[period][observedKey(period, now)]?.[harnessId] ??
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
      quota: cloneQuota(
        this.quotaCache.get(harnessId) ?? this.createUnavailableQuota(harnessId)
      ),
      observed:
        this.observedCache.get(harnessId) ?? this.emptyObservedPeriods(),
    };
  }

  private emptyObservedPeriods(): HarnessUsageSnapshot["observed"] {
    const now = this.now();
    return Object.fromEntries(
      Object.values(HARNESS_OBSERVED_PERIODS).map((period) => [
        period,
        emptyObserved(period, now),
      ])
    ) as HarnessUsageSnapshot["observed"];
  }

  private createUnavailableQuota(
    harnessId: HarnessId,
    errorCode?: string
  ): HarnessQuotaSnapshot {
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
      const parsed: unknown = migrateToCurrent(
        PERSISTED_STORES.PROVIDER_USAGE,
        JSON.parse(raw)
      ).doc;
      assertWritableSchema(
        PERSISTED_STORES.PROVIDER_USAGE,
        parsed,
        this.providerSnapshotsFile
      );
      if (
        !isRecord(parsed) ||
        parsed.schemaVersion !== PROVIDER_USAGE_SCHEMA_VERSION ||
        !isRecord(parsed.snapshots)
      ) {
        throw new Error(HARNESS_USAGE_ERROR_CODES.MALFORMED_PROVIDER_DATA);
      }
      let loadedAny = false;
      for (const [harnessId, value] of Object.entries(parsed.snapshots)) {
        if (VALID_HARNESS_IDS.has(harnessId as HarnessId) && isRecord(value)) {
          const quota = value as unknown as HarnessQuotaSnapshot;
          if (
            Array.isArray(quota.windows) &&
            typeof quota.source === "string"
          ) {
            this.quotaCache.set(harnessId as HarnessId, normalizeQuota(quota));
            loadedAny = true;
          }
        }
      }
      // Construction seeds every harness with a placeholder unavailable quota
      // synchronously, and this disk read finishes asynchronously afterward —
      // publish so a client that already requested usage before this resolved
      // (e.g. the dashboard's first paint in a brand-new workspace) gets the
      // machine-wide last-known quota promptly, rather than only picking it up
      // incidentally the next time something else calls refreshOne().
      if (loadedAny) {
        this.publish();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // A newer ctrlyoke's file is left for it; this host starts empty.
      if (isNewerSchemaError(error)) return;
      await this.quarantineProviderSnapshotFile();
    }
  }

  protected async persistProviderSnapshots(): Promise<void> {
    try {
      await ensurePrivateDirectory(path.dirname(this.providerSnapshotsFile));
      await withFileLock(this.providerSnapshotsFile, async () => {
        const persisted = await readPersistedProviderUsage(
          this.providerSnapshotsFile
        );
        const snapshots: Partial<Record<HarnessId, HarnessQuotaSnapshot>> = {};
        for (const harnessId of HARNESS_ID_LIST) {
          const current = this.quotaCache.get(harnessId);
          const foreign = persisted?.snapshots[harnessId];
          const quota = selectNewestQuota(current, foreign);
          if (quota?.fetchedAt !== undefined) {
            snapshots[harnessId] = stripPersistedQuota(quota);
          }
        }
        const data: PersistedProviderUsage = {
          schemaVersion: PROVIDER_USAGE_SCHEMA_VERSION,
          snapshots,
        };
        const tempPath = `${this.providerSnapshotsFile}.${process.pid}.${this.now()}.tmp`;
        try {
          await fs.writeFile(tempPath, JSON.stringify(data, null, 2), {
            encoding: "utf8",
            mode: 0o600,
          });
          await fs.chmod(tempPath, 0o600);
          await renameWithTransientRetry(tempPath, this.providerSnapshotsFile);
          await fs.chmod(this.providerSnapshotsFile, 0o600);
        } catch (error) {
          await fs.unlink(tempPath).catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      // Provider persistence is best effort and never affects execution — but
      // swallowing it silently is what made a dropped snapshot look like a
      // flaky test rather than a lost write, so say so at debug level.
      Log.debug(
        `[HarnessUsageService] provider snapshot persistence failed: ${getErrorMessage(error)}`
      );
    }
  }

  private async quarantineProviderSnapshotFile(): Promise<void> {
    await fs
      .rename(
        this.providerSnapshotsFile,
        `${this.providerSnapshotsFile}.corrupt-${this.now()}.json`
      )
      .catch(() => undefined);
  }
}

function selectNewestQuota(
  current: HarnessQuotaSnapshot | undefined,
  foreign: HarnessQuotaSnapshot | undefined
): HarnessQuotaSnapshot | undefined {
  if (!current) return foreign;
  if (!foreign) return current;
  return (foreign.fetchedAt ?? 0) > (current.fetchedAt ?? 0)
    ? foreign
    : current;
}

function stripPersistedQuota(
  quota: HarnessQuotaSnapshot
): HarnessQuotaSnapshot {
  return {
    ...cloneQuota(quota),
    message: undefined,
  };
}

/**
 * The persisted snapshots, or `undefined` when absent or unreadable. Throws
 * `NewerSchemaError` for a file a newer ctrlyoke wrote, so the persist path
 * skips its write instead of replacing that file.
 */
async function readPersistedProviderUsage(
  filePath: string
): Promise<PersistedProviderUsage | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = migrateToCurrent(
      PERSISTED_STORES.PROVIDER_USAGE,
      JSON.parse(raw)
    ).doc;
    assertWritableSchema(PERSISTED_STORES.PROVIDER_USAGE, parsed, filePath);
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== PROVIDER_USAGE_SCHEMA_VERSION ||
      !isRecord(parsed.snapshots)
    ) {
      return undefined;
    }

    const snapshots: Partial<Record<HarnessId, HarnessQuotaSnapshot>> = {};
    for (const [harnessId, value] of Object.entries(parsed.snapshots)) {
      if (
        VALID_HARNESS_IDS.has(harnessId as HarnessId) &&
        isRecord(value) &&
        Array.isArray(value.windows) &&
        typeof value.source === "string" &&
        typeof value.fetchedAt === "number"
      ) {
        snapshots[harnessId as HarnessId] = normalizeQuota(
          value as unknown as HarnessQuotaSnapshot
        );
      }
    }
    return { schemaVersion: PROVIDER_USAGE_SCHEMA_VERSION, snapshots };
  } catch (error) {
    if (isNewerSchemaError(error)) throw error;
    return undefined;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}
