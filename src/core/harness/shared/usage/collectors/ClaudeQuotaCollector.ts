import {
  isRecord,
  parseFiniteNumber as asFiniteNumber,
} from "../../../../../utils/JsonTypeGuards";
import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_FRESHNESS_MS,
  HARNESS_USAGE_STATUS_CODES,
  HARNESS_USAGE_UNITS,
  formatUsageWindowLabel,
  usageWindowKind,
} from "../../../../../types/DashboardConstants";
import type {
  HarnessQuotaSnapshot,
  HarnessUsageWindow,
} from "../../../../../types/UsageTypes";
import { CLAUDE_RATE_LIMIT_WINDOWS } from "../../../../../utils/StatuslineFormat";
import { normalizeUsageTimestamp } from "../UsageTimestampUtils";
import type { IHarnessQuotaCollector } from "../IHarnessQuotaCollector";
import { ObservedOnlyQuotaCollector } from "../ObservedOnlyQuotaCollector";

export interface ClaudeStatuslineSnapshot {
  [key: string]: unknown;
  _ctrlyoke?: {
    sequence?: unknown;
    writtenAt?: unknown;
  };
  rate_limits?: unknown;
}

/** Parse only the normalized quota numbers from Claude's version-sensitive payload. */
export function parseClaudeRateLimitWindows(
  payload: unknown
): HarnessUsageWindow[] {
  if (!isRecord(payload) || !isRecord(payload.rate_limits)) {
    return [];
  }

  const windows: HarnessUsageWindow[] = [];
  for (const definition of CLAUDE_RATE_LIMIT_WINDOWS) {
    const rawWindow = payload.rate_limits[definition.key];
    if (!isRecord(rawWindow)) {
      continue;
    }
    const usedPercentage = asFiniteNumber(rawWindow.used_percentage);
    if (
      usedPercentage === undefined ||
      usedPercentage < 0 ||
      usedPercentage > 100
    ) {
      continue;
    }
    const resetAt = normalizeUsageTimestamp(rawWindow.resets_at);
    windows.push({
      id: definition.id,
      kind: usageWindowKind(definition.windowMinutes),
      label: formatUsageWindowLabel(definition.windowMinutes),
      used: usedPercentage,
      limit: 100,
      remaining: 100 - usedPercentage,
      percentUsed: usedPercentage,
      ...(resetAt !== undefined ? { resetAt } : {}),
      windowMinutes: definition.windowMinutes,
      unit: HARNESS_USAGE_UNITS.PERCENT,
      confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
    });
  }
  return windows;
}

/** Convert one accepted statusline payload into the durable normalized quota contract. */
export function parseClaudeQuotaSnapshot(
  payload: unknown,
  fetchedAt: unknown = Date.now()
): HarnessQuotaSnapshot | undefined {
  const windows = parseClaudeRateLimitWindows(payload);
  const normalizedFetchedAt = normalizeUsageTimestamp(fetchedAt);
  if (windows.length === 0 || normalizedFetchedAt === undefined) {
    return undefined;
  }
  return {
    harnessId: HARNESS_IDS.CLAUDE_CLI,
    source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
    fetchedAt: normalizedFetchedAt,
    staleAfterMs: HARNESS_USAGE_FRESHNESS_MS.PROVIDER_LIVE,
    windows,
  };
}

export class ClaudeQuotaCollector
  extends ObservedOnlyQuotaCollector
  implements IHarnessQuotaCollector
{
  constructor() {
    super(HARNESS_IDS.CLAUDE_CLI);
  }

  async refreshUsage(_signal?: AbortSignal): Promise<HarnessQuotaSnapshot> {
    // Claude exposes rate limits through an active statusline invocation, not
    // through a safe standalone probe. The sidecar push path supplies live data.
    // errorCode (rather than a bare unavailable) tells the dashboard this is a
    // "no push yet" state, not "this provider doesn't report quota" — and lets
    // HarnessUsageService.refreshOne preserve a prior live snapshot untouched.
    return {
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      source: HARNESS_QUOTA_SOURCES.UNAVAILABLE,
      staleAfterMs: 0,
      windows: [],
      errorCode: HARNESS_USAGE_STATUS_CODES.SIDECAR_PENDING,
    };
  }
}
