import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  type HarnessQuotaSource,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_FRESHNESS_MS,
  HARNESS_USAGE_UNITS,
  formatUsageWindowLabel,
  usageWindowKind,
} from "../../../types/DashboardConstants";
import type { HarnessQuotaSnapshot } from "../../../types/UsageTypes";
import type { HarnessUsageWindow } from "../../../types/UsageTypes";
import { normalizeUsageTimestamp } from "../shared/usage/UsageTimestampUtils";

interface CodexRateLimitBucket {
  limitId?: unknown;
  limitName?: unknown;
  primary?: unknown;
  secondary?: unknown;
  planType?: unknown;
  plan_type?: unknown;
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

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBucketWindow(
  bucketId: string,
  bucketName: string | undefined,
  period: "primary" | "secondary",
  rawWindow: unknown,
  source: HarnessQuotaSource
): HarnessUsageWindow | undefined {
  if (!isRecord(rawWindow)) return undefined;

  const usedPercent = asFiniteNumber(
    rawWindow.usedPercent ?? rawWindow.used_percent
  );
  const windowMinutes = asFiniteNumber(
    rawWindow.windowDurationMins ?? rawWindow.window_minutes
  );
  if (
    usedPercent === undefined ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    windowMinutes === undefined ||
    windowMinutes <= 0
  ) {
    return undefined;
  }

  const resetAt = normalizeUsageTimestamp(
    rawWindow.resetsAt ?? rawWindow.resets_at
  );
  const label = formatUsageWindowLabel(windowMinutes);
  const id = `codex:${bucketId}:${period}`;
  return {
    id,
    kind: usageWindowKind(windowMinutes),
    label: bucketName ? `${bucketName} ${label}` : label,
    used: usedPercent,
    limit: 100,
    remaining: 100 - usedPercent,
    percentUsed: usedPercent,
    ...(resetAt !== undefined ? { resetAt } : {}),
    windowMinutes,
    unit: HARNESS_USAGE_UNITS.PERCENT,
    confidence:
      source === HARNESS_QUOTA_SOURCES.PROVIDER_LOG
        ? HARNESS_USAGE_CONFIDENCE.LAST_KNOWN
        : HARNESS_USAGE_CONFIDENCE.EXACT,
  };
}

function buildQuotaSnapshot(
  buckets: readonly CodexRateLimitBucket[],
  source: HarnessQuotaSource,
  fetchedAt: unknown
): HarnessQuotaSnapshot | undefined {
  const windowsById = new Map<string, HarnessUsageWindow>();
  let planType: string | undefined;

  for (const bucket of buckets) {
    const bucketId = asNonEmptyString(bucket.limitId) ?? "codex";
    const bucketName = asNonEmptyString(bucket.limitName);
    planType ??=
      asNonEmptyString(bucket.planType) ?? asNonEmptyString(bucket.plan_type);
    for (const period of ["primary", "secondary"] as const) {
      const window = normalizeBucketWindow(
        bucketId,
        bucketName,
        period,
        bucket[period],
        source
      );
      if (window) windowsById.set(window.id, window);
    }
  }

  const normalizedFetchedAt = normalizeUsageTimestamp(fetchedAt);
  if (windowsById.size === 0 || normalizedFetchedAt === undefined) {
    return undefined;
  }

  return {
    harnessId: HARNESS_IDS.CODEX_CLI,
    source,
    fetchedAt: normalizedFetchedAt,
    staleAfterMs:
      source === HARNESS_QUOTA_SOURCES.PROVIDER_LOG
        ? HARNESS_USAGE_FRESHNESS_MS.PROVIDER_LOG
        : HARNESS_USAGE_FRESHNESS_MS.PROVIDER_LIVE,
    windows: [...windowsById.values()],
    ...(planType ? { planType } : {}),
  };
}

/** Normalize the documented app-server result, retaining quota fields only. */
export function normalizeCodexAppServerQuota(
  payload: unknown,
  fetchedAt: unknown = Date.now()
): HarnessQuotaSnapshot | undefined {
  if (!isRecord(payload)) return undefined;

  const buckets: CodexRateLimitBucket[] = [];
  if (isRecord(payload.rateLimitsByLimitId)) {
    for (const [limitId, value] of Object.entries(
      payload.rateLimitsByLimitId
    )) {
      if (isRecord(value)) {
        buckets.push({ ...value, limitId });
      }
    }
  }
  if (buckets.length === 0 && isRecord(payload.rateLimits)) {
    buckets.push(payload.rateLimits);
  }

  return buildQuotaSnapshot(
    buckets,
    HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
    fetchedAt
  );
}

/** Normalize Codex's best-effort rollout `token_count.rate_limits` object. */
export function normalizeCodexRolloutQuota(
  payload: unknown,
  fetchedAt: unknown = Date.now()
): HarnessQuotaSnapshot | undefined {
  if (!isRecord(payload)) return undefined;
  return buildQuotaSnapshot(
    [
      {
        limitId: "codex",
        primary: payload.primary,
        secondary: payload.secondary,
        plan_type: payload.plan_type,
      },
    ],
    HARNESS_QUOTA_SOURCES.PROVIDER_LOG,
    fetchedAt
  );
}
