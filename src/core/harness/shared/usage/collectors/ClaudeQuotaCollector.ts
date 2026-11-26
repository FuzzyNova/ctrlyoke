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

type ClaudeRateLimitWindowDefinition =
  (typeof CLAUDE_RATE_LIMIT_WINDOWS)[number];

/** One normalized percent window, or `undefined` for an out-of-range value. */
function buildClaudeRateLimitWindow(
  definition: ClaudeRateLimitWindowDefinition,
  usedPercentage: number | undefined,
  rawResetAt: unknown
): HarnessUsageWindow | undefined {
  if (
    usedPercentage === undefined ||
    usedPercentage < 0 ||
    usedPercentage > 100
  ) {
    return undefined;
  }
  const resetAt = normalizeUsageTimestamp(rawResetAt);
  return {
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
  };
}

/**
 * Map each known window present in `source` through `readWindow`, which
 * returns the window's used percentage and raw reset time.
 */
function collectClaudeRateLimitWindows(
  source: Record<string, unknown>,
  readWindow: (raw: Record<string, unknown>) => {
    usedPercentage: number | undefined;
    resetAt: unknown;
  }
): HarnessUsageWindow[] {
  const windows: HarnessUsageWindow[] = [];
  for (const definition of CLAUDE_RATE_LIMIT_WINDOWS) {
    const rawWindow = source[definition.key];
    if (!isRecord(rawWindow)) {
      continue;
    }
    const { usedPercentage, resetAt } = readWindow(rawWindow);
    const window = buildClaudeRateLimitWindow(
      definition,
      usedPercentage,
      resetAt
    );
    if (window) {
      windows.push(window);
    }
  }
  return windows;
}

/** Parse only the normalized quota numbers from Claude's version-sensitive payload. */
export function parseClaudeRateLimitWindows(
  payload: unknown
): HarnessUsageWindow[] {
  if (!isRecord(payload) || !isRecord(payload.rate_limits)) {
    return [];
  }
  return collectClaudeRateLimitWindows(payload.rate_limits, (raw) => ({
    usedPercentage: asFiniteNumber(raw.used_percentage),
    resetAt: raw.resets_at,
  }));
}

/**
 * Parse the windows of a headless stream-json `rate_limit_event`.
 *
 * Headless Claude never runs the statusline, so this event is its only quota
 * signal. Its shape is undocumented (observed on Claude Code 2.1.332):
 * `rate_limit_info.unifiedWindows.<five_hour|seven_day>` carries
 * `utilization` as a 0-1 fraction and `resetsAt` in epoch seconds. Anything
 * else yields no windows, so a format change shows stale quota rather than a
 * wrong number.
 */
export function parseClaudeRateLimitEventWindows(
  event: unknown
): HarnessUsageWindow[] {
  if (
    !isRecord(event) ||
    !isRecord(event.rate_limit_info) ||
    !isRecord(event.rate_limit_info.unifiedWindows)
  ) {
    return [];
  }
  return collectClaudeRateLimitWindows(
    event.rate_limit_info.unifiedWindows,
    (raw) => {
      const utilization = asFiniteNumber(raw.utilization);
      return {
        usedPercentage:
          utilization === undefined || utilization < 0 || utilization > 1
            ? undefined
            : Math.round(utilization * 1000) / 10,
        resetAt: raw.resetsAt,
      };
    }
  );
}

function buildClaudeQuotaSnapshot(
  windows: HarnessUsageWindow[],
  fetchedAt: unknown
): HarnessQuotaSnapshot | undefined {
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

/** Convert one headless `rate_limit_event` into the normalized quota contract. */
export function parseClaudeRateLimitEventQuota(
  event: unknown,
  fetchedAt: number
): HarnessQuotaSnapshot | undefined {
  return buildClaudeQuotaSnapshot(
    parseClaudeRateLimitEventWindows(event),
    fetchedAt
  );
}

/** Convert one accepted statusline payload into the durable normalized quota contract. */
export function parseClaudeQuotaSnapshot(
  payload: unknown,
  fetchedAt: unknown = Date.now()
): HarnessQuotaSnapshot | undefined {
  return buildClaudeQuotaSnapshot(
    parseClaudeRateLimitWindows(payload),
    fetchedAt
  );
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
