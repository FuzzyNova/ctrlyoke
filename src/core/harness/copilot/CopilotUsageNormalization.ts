import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_FRESHNESS_MS,
  HARNESS_USAGE_UNITS,
  HARNESS_USAGE_WINDOW_KINDS,
} from "../../../types/DashboardConstants";
import type {
  HarnessQuotaSnapshot,
  HarnessUsageWindow,
} from "../../../types/UsageTypes";
import { normalizeUsageTimestamp } from "../shared/usage/UsageTimestampUtils";

export const COPILOT_QUOTA_STATUS_CODES = {
  UNSUPPORTED: "copilot-quota-unsupported",
  TIMEOUT: "copilot-quota-timeout",
  MALFORMED_RESPONSE: "copilot-quota-malformed-response",
  PROBE_FAILED: "copilot-quota-probe-failed",
} as const;

const COPILOT_QUOTA_BUCKET_KEYS = {
  PREMIUM_INTERACTIONS: "premium_interactions",
  CHAT: "chat",
  COMPLETIONS: "completions",
} as const;

const KNOWN_BUCKET_ORDER = [
  COPILOT_QUOTA_BUCKET_KEYS.PREMIUM_INTERACTIONS,
  COPILOT_QUOTA_BUCKET_KEYS.CHAT,
  COPILOT_QUOTA_BUCKET_KEYS.COMPLETIONS,
] as const;

const BUCKET_LABELS: Record<string, string> = {
  [COPILOT_QUOTA_BUCKET_KEYS.PREMIUM_INTERACTIONS]: "Premium interactions",
  [COPILOT_QUOTA_BUCKET_KEYS.CHAT]: "Chat",
  [COPILOT_QUOTA_BUCKET_KEYS.COMPLETIONS]: "Completions",
};

const PREMIUM_INTERACTIONS_AMBIGUOUS_NOTE =
  "This may be either AI credits or premium requests, depending on your plan.";

/**
 * GitHub's account.getQuota RPC does not document a unit for the
 * `premium_interactions` bucket: it can represent either AI credits or
 * legacy premium requests depending on the account's plan. An undocumented
 * `tokenBasedBilling` flag has been observed on the wire and, when present,
 * says which one — use it to show the real unit instead of the ambiguous
 * bucket name, and fall back to a tooltip note when it's absent.
 */
function resolvePremiumInteractionsLabel(bucket: Record<string, unknown>): {
  label: string;
  note?: string;
} {
  const tokenBasedBilling = readOptionalBoolean(
    bucket,
    "tokenBasedBilling",
    "token_based_billing"
  );
  if (tokenBasedBilling.value === true) {
    return { label: "AI credits" };
  }
  if (tokenBasedBilling.value === false) {
    return { label: "Premium requests" };
  }
  return {
    label: BUCKET_LABELS[COPILOT_QUOTA_BUCKET_KEYS.PREMIUM_INTERACTIONS],
    note: PREMIUM_INTERACTIONS_AMBIGUOUS_NOTE,
  };
}

interface CopilotQuotaSnapshotWire {
  isUnlimitedEntitlement?: unknown;
  is_unlimited_entitlement?: unknown;
  entitlementRequests?: unknown;
  entitlement_requests?: unknown;
  usedRequests?: unknown;
  used_requests?: unknown;
  usageAllowedWithExhaustedQuota?: unknown;
  usage_allowed_with_exhausted_quota?: unknown;
  overageAllowedWithExhaustedQuota?: unknown;
  overage_allowed_with_exhausted_quota?: unknown;
  usageAllowedAfterLimit?: unknown;
  usage_allowed_after_limit?: unknown;
  remainingPercentage?: unknown;
  remaining_percentage?: unknown;
  overage?: unknown;
  resetDate?: unknown;
  reset_date?: unknown;
  tokenBasedBilling?: unknown;
  token_based_billing?: unknown;
}

interface CopilotQuotaResultWire {
  quotaSnapshots?: unknown;
}

interface OptionalNumber {
  present: boolean;
  value?: number;
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

function readField(
  record: Record<string, unknown>,
  camelCase: string,
  snakeCase: string
): unknown {
  if (Object.prototype.hasOwnProperty.call(record, camelCase)) {
    return record[camelCase];
  }
  return record[snakeCase];
}

function readOptionalNumber(
  record: Record<string, unknown>,
  camelCase: string,
  snakeCase: string
): OptionalNumber {
  const raw = readField(record, camelCase, snakeCase);
  if (raw === undefined || raw === null) return { present: false };
  const value = asFiniteNumber(raw);
  return value === undefined ? { present: true } : { present: true, value };
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  camelCase: string,
  snakeCase: string
): { present: boolean; value?: boolean } {
  const raw = readField(record, camelCase, snakeCase);
  if (raw === undefined || raw === null) return { present: false };
  return typeof raw === "boolean"
    ? { present: true, value: raw }
    : { present: true };
}

function humanizeBucketKey(bucketKey: string): string | undefined {
  if (!/^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/.test(bucketKey)) {
    return undefined;
  }
  const words = bucketKey.split(/[_-]/u);
  return words
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function canDeriveRemaining(
  used: number,
  limit: number,
  remainingPercentage: number
): boolean {
  if (limit === 0) return used === 0 && remainingPercentage === 0;
  if (used < 0 || used > limit) return false;
  const derivedPercentage = ((limit - used) / limit) * 100;
  return Math.abs(derivedPercentage - remainingPercentage) <= 1;
}

function normalizeBucketWindow(
  bucketKey: string,
  rawBucket: unknown,
  fetchedAt: number
): HarnessUsageWindow | undefined {
  if (!isRecord(rawBucket)) return undefined;

  const bucket = rawBucket as Record<string, unknown> &
    CopilotQuotaSnapshotWire;
  const usedRequests = readOptionalNumber(
    bucket,
    "usedRequests",
    "used_requests"
  );
  if (!usedRequests.present || usedRequests.value === undefined) {
    return undefined;
  }
  const used = usedRequests.value;
  if (used < 0) return undefined;

  const unlimited = readOptionalBoolean(
    bucket,
    "isUnlimitedEntitlement",
    "is_unlimited_entitlement"
  );
  if (unlimited.present && unlimited.value === undefined) return undefined;

  const entitlementRequests = readOptionalNumber(
    bucket,
    "entitlementRequests",
    "entitlement_requests"
  );
  if (entitlementRequests.present && entitlementRequests.value === undefined) {
    return undefined;
  }
  const entitlement = entitlementRequests.value;
  const isUnlimited = unlimited.value === true || entitlement === -1;
  if (entitlement !== undefined && entitlement < 0 && entitlement !== -1) {
    return undefined;
  }

  const remainingPercentage = readOptionalNumber(
    bucket,
    "remainingPercentage",
    "remaining_percentage"
  );
  if (
    !isUnlimited &&
    (!remainingPercentage.present || remainingPercentage.value === undefined)
  ) {
    return undefined;
  }
  if (remainingPercentage.present && remainingPercentage.value === undefined) {
    return undefined;
  }

  const overage = readOptionalNumber(bucket, "overage", "overage");
  if (overage.present && (overage.value === undefined || overage.value < 0)) {
    return undefined;
  }

  const usageAllowed = readOptionalBoolean(
    bucket,
    "usageAllowedWithExhaustedQuota",
    "usage_allowed_with_exhausted_quota"
  );
  const overageAllowed = readOptionalBoolean(
    bucket,
    "overageAllowedWithExhaustedQuota",
    "overage_allowed_with_exhausted_quota"
  );
  const usageAllowedAlias = readOptionalBoolean(
    bucket,
    "usageAllowedAfterLimit",
    "usage_allowed_after_limit"
  );
  if (
    (usageAllowed.present && usageAllowed.value === undefined) ||
    (overageAllowed.present && overageAllowed.value === undefined) ||
    (usageAllowedAlias.present && usageAllowedAlias.value === undefined)
  ) {
    return undefined;
  }
  const usageAllowedAfterLimit =
    overageAllowed.value ?? usageAllowed.value ?? usageAllowedAlias.value;

  const rawResetDate = readField(bucket, "resetDate", "reset_date");
  const parsedResetAt =
    rawResetDate === undefined || rawResetDate === null
      ? undefined
      : normalizeUsageTimestamp(rawResetDate);
  if (
    rawResetDate !== undefined &&
    rawResetDate !== null &&
    parsedResetAt === undefined
  ) {
    return undefined;
  }
  // Copilot's account.getQuota RPC has been observed returning `resetDate`
  // at or before the fetch time even for a partially-used monthly bucket
  // that plainly has not just reset. A genuine reset date is always in the
  // future, so drop implausible values instead of showing a "resets now"
  // time — but keep the rest of the bucket's data, since it's still valid.
  const resetAt =
    parsedResetAt !== undefined && parsedResetAt > fetchedAt
      ? parsedResetAt
      : undefined;

  const baseLabel = BUCKET_LABELS[bucketKey] ?? humanizeBucketKey(bucketKey);
  if (baseLabel === undefined) return undefined;
  const { label, note } =
    bucketKey === COPILOT_QUOTA_BUCKET_KEYS.PREMIUM_INTERACTIONS
      ? resolvePremiumInteractionsLabel(bucket)
      : { label: baseLabel, note: undefined };

  const window: HarnessUsageWindow = {
    id: `copilot:${bucketKey}`,
    kind: BUCKET_LABELS[bucketKey]
      ? HARNESS_USAGE_WINDOW_KINDS.MONTHLY
      : HARNESS_USAGE_WINDOW_KINDS.UNKNOWN,
    label,
    ...(note !== undefined ? { note } : {}),
    used,
    ...(isUnlimited ? { isUnlimited: true } : {}),
    ...(!isUnlimited && entitlement !== undefined && entitlement >= 0
      ? { limit: entitlement }
      : {}),
    ...(overage.value !== undefined ? { overage: overage.value } : {}),
    ...(usageAllowedAfterLimit !== undefined ? { usageAllowedAfterLimit } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    unit: HARNESS_USAGE_UNITS.REQUESTS,
    confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
  };

  if (!isUnlimited && remainingPercentage.value !== undefined) {
    window.percentUsed = clamp(100 - remainingPercentage.value, 0, 100);
    if (
      entitlement !== undefined &&
      canDeriveRemaining(used, entitlement, remainingPercentage.value)
    ) {
      window.remaining = entitlement - used;
    }
  }

  return window;
}

function orderedBucketKeys(quotaSnapshots: Record<string, unknown>): string[] {
  const known = KNOWN_BUCKET_ORDER.filter((key) =>
    Object.prototype.hasOwnProperty.call(quotaSnapshots, key)
  );
  const unknown = Object.keys(quotaSnapshots)
    .filter(
      (key) =>
        !KNOWN_BUCKET_ORDER.includes(key as (typeof KNOWN_BUCKET_ORDER)[number])
    )
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return [...known, ...unknown];
}

/** Normalize the experimental Copilot `account.getQuota` result. */
export function normalizeCopilotAccountQuota(
  payload: unknown,
  fetchedAt: unknown = Date.now()
): HarnessQuotaSnapshot | undefined {
  if (!isRecord(payload)) return undefined;
  const result = payload as CopilotQuotaResultWire;
  if (!isRecord(result.quotaSnapshots)) return undefined;

  const normalizedFetchedAt = normalizeUsageTimestamp(fetchedAt);
  if (normalizedFetchedAt === undefined) return undefined;

  const windows: HarnessUsageWindow[] = [];
  for (const bucketKey of orderedBucketKeys(result.quotaSnapshots)) {
    const window = normalizeBucketWindow(
      bucketKey,
      result.quotaSnapshots[bucketKey],
      normalizedFetchedAt
    );
    if (window) windows.push(window);
  }
  if (windows.length === 0) return undefined;

  return {
    harnessId: HARNESS_IDS.COPILOT_CLI,
    source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
    fetchedAt: normalizedFetchedAt,
    staleAfterMs: HARNESS_USAGE_FRESHNESS_MS.PROVIDER_LIVE,
    windows,
  };
}
