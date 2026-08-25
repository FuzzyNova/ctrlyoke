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
import { normalizeUsageTimestamp } from "../UsageTimestampUtils";
import type { IHarnessUsageProvider } from "../IHarnessUsageProvider";
import { ObservedOnlyUsageProvider } from "../ObservedOnlyUsageProvider";

export interface ClaudeStatuslineSnapshot {
  [key: string]: unknown;
  _ctrlyoke?: {
    sequence?: unknown;
    writtenAt?: unknown;
  };
  rate_limits?: unknown;
}

const CLAUDE_RATE_LIMIT_WINDOWS = [
  {
    key: "five_hour",
    id: "five-hour",
    windowMinutes: 5 * 60,
  },
  {
    key: "seven_day",
    id: "seven-day",
    windowMinutes: 7 * 24 * 60,
  },
] as const;

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

export class ClaudeUsageProvider
  extends ObservedOnlyUsageProvider
  implements IHarnessUsageProvider
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
