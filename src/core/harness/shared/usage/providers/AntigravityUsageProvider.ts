import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_FRESHNESS_MS,
  HARNESS_USAGE_STATUS_CODES,
  HARNESS_USAGE_UNITS,
} from "../../../../../types/DashboardConstants";
import type {
  HarnessQuotaSnapshot,
  HarnessUsageWindow,
} from "../../../../../types/UsageTypes";
import {
  humanizeQuotaKey,
  quotaWindowKind,
} from "../../../../../utils/StatuslineFormat";
import { normalizeUsageTimestamp } from "../UsageTimestampUtils";
import type { IHarnessUsageProvider } from "../IHarnessUsageProvider";

/** Raw quota entry shape emitted by the Antigravity statusline payload. */
export interface AntigravityStatuslineQuotaEntry {
  remaining_fraction?: unknown;
  reset_time?: unknown;
  reset_in_seconds?: unknown;
}

/** Typed boundary for the open-ended statusline quota map. */
export interface AntigravityStatuslineQuotaSnapshot {
  quota?: Record<string, AntigravityStatuslineQuotaEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Parse dynamic Antigravity plan tiers into the normalized live quota contract. */
export function parseAntigravityQuotaSnapshot(
  snapshot: unknown,
  fetchedAt: unknown = Date.now()
): HarnessQuotaSnapshot | undefined {
  if (!isRecord(snapshot) || !isRecord(snapshot.quota)) {
    return undefined;
  }

  const windows: HarnessUsageWindow[] = [];
  for (const [id, rawEntry] of Object.entries(snapshot.quota)) {
    if (!isRecord(rawEntry)) {
      continue;
    }
    const remainingFraction = asFiniteNumber(rawEntry.remaining_fraction);
    if (
      remainingFraction === undefined ||
      remainingFraction < 0 ||
      remainingFraction > 1
    ) {
      continue;
    }

    const resetAt = normalizeUsageTimestamp(rawEntry.reset_time);
    const percentRemaining = remainingFraction * 100;
    const percentUsed = (1 - remainingFraction) * 100;
    windows.push({
      id,
      kind: quotaWindowKind(id),
      label: humanizeQuotaKey(id),
      used: percentUsed,
      limit: 100,
      remaining: percentRemaining,
      percentUsed,
      ...(resetAt !== undefined ? { resetAt } : {}),
      unit: HARNESS_USAGE_UNITS.PERCENT,
      confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
    });
  }

  const normalizedFetchedAt = normalizeUsageTimestamp(fetchedAt);
  if (windows.length === 0 || normalizedFetchedAt === undefined) {
    return undefined;
  }

  return {
    harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
    source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
    fetchedAt: normalizedFetchedAt,
    staleAfterMs: HARNESS_USAGE_FRESHNESS_MS.PROVIDER_LIVE,
    windows,
  };
}

export class AntigravityUsageProvider implements IHarnessUsageProvider {
  readonly harnessId = HARNESS_IDS.ANTIGRAVITY_CLI;

  async refreshUsage(_signal?: AbortSignal): Promise<HarnessQuotaSnapshot> {
    // Antigravity exposes quota through an active statusline invocation, not a
    // safe standalone probe. The sidecar supplies provider-live snapshots.
    // errorCode (rather than a bare unavailable) tells the dashboard this is a
    // "no push yet" state, not "this provider doesn't report quota" — and lets
    // HarnessUsageService.refreshOne preserve a prior live snapshot untouched.
    return {
      harnessId: this.harnessId,
      source: HARNESS_QUOTA_SOURCES.UNAVAILABLE,
      staleAfterMs: 0,
      windows: [],
      errorCode: HARNESS_USAGE_STATUS_CODES.SIDECAR_PENDING,
    };
  }
}
