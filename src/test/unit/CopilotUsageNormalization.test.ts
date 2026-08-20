import * as assert from "assert";
import { suite, test } from "mocha";
import { normalizeCopilotAccountQuota } from "../../core/harness/copilot/CopilotUsageNormalization";
import {
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_UNITS,
  HARNESS_USAGE_WINDOW_KINDS,
} from "../../types/DashboardConstants";

const FETCHED_AT = 1_700_000_000_000;

function quotaSnapshots(
  snapshots: Record<string, unknown>
): Record<string, unknown> {
  return { quotaSnapshots: snapshots };
}

suite("Copilot usage normalization", () => {
  test("normalizes a finite premium-interactions monthly bucket", () => {
    const quota = normalizeCopilotAccountQuota(
      quotaSnapshots({
        premium_interactions: {
          entitlementRequests: 1_500,
          usedRequests: 555,
          remainingPercentage: 63,
          resetDate: "2026-09-01T00:00:00.000Z",
        },
      }),
      FETCHED_AT
    );

    assert.ok(quota);
    assert.deepStrictEqual(quota.windows[0], {
      id: "copilot:premium_interactions",
      kind: HARNESS_USAGE_WINDOW_KINDS.MONTHLY,
      label: "Premium interactions",
      used: 555,
      limit: 1_500,
      remaining: 945,
      percentUsed: 37,
      resetAt: Date.parse("2026-09-01T00:00:00.000Z"),
      unit: HARNESS_USAGE_UNITS.REQUESTS,
      confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
    });
    assert.strictEqual(quota.source, HARNESS_QUOTA_SOURCES.PROVIDER_LIVE);
    assert.strictEqual(quota.fetchedAt, FETCHED_AT);
  });

  test("keeps chat and completions independent in their documented order", () => {
    const quota = normalizeCopilotAccountQuota(
      quotaSnapshots({
        completions: {
          entitlementRequests: 20,
          usedRequests: 4,
          remainingPercentage: 80,
        },
        chat: {
          entitlementRequests: 100,
          usedRequests: 25,
          remainingPercentage: 75,
        },
      }),
      FETCHED_AT
    );

    assert.deepStrictEqual(
      quota?.windows.map((window) => [window.id, window.used, window.limit]),
      [
        ["copilot:chat", 25, 100],
        ["copilot:completions", 4, 20],
      ]
    );
  });

  test("uses the provider percentage once and does not re-derive it from totals", () => {
    const quota = normalizeCopilotAccountQuota(
      quotaSnapshots({
        premium_interactions: {
          entitlementRequests: 1_000,
          usedRequests: 500,
          remainingPercentage: 20,
        },
      }),
      FETCHED_AT
    );

    assert.strictEqual(quota?.windows[0].percentUsed, 80);
    assert.strictEqual(quota?.windows[0].remaining, undefined);
  });

  test("represents unlimited entitlement without a finite limit or percentage", () => {
    const quota = normalizeCopilotAccountQuota(
      quotaSnapshots({
        premium_interactions: {
          isUnlimitedEntitlement: true,
          entitlementRequests: -1,
          usedRequests: 12,
          remainingPercentage: 100,
        },
      }),
      FETCHED_AT
    );

    const window = quota?.windows[0];
    assert.strictEqual(window?.isUnlimited, true);
    assert.strictEqual(window?.limit, undefined);
    assert.strictEqual(window?.percentUsed, undefined);
    assert.strictEqual(window?.remaining, undefined);
  });

  test("preserves exhausted and overage-permitted states", () => {
    const quota = normalizeCopilotAccountQuota(
      quotaSnapshots({
        chat: {
          entitlementRequests: 100,
          usedRequests: 100,
          remainingPercentage: 0,
          overage: 7,
          overageAllowedWithExhaustedQuota: true,
        },
        completions: {
          entitlementRequests: 100,
          usedRequests: 100,
          remainingPercentage: 0,
          overage: 0,
          usageAllowedWithExhaustedQuota: false,
        },
      }),
      FETCHED_AT
    );

    assert.strictEqual(quota?.windows[0].percentUsed, 100);
    assert.strictEqual(quota?.windows[0].remaining, 0);
    assert.strictEqual(quota?.windows[0].overage, 7);
    assert.strictEqual(quota?.windows[0].usageAllowedAfterLimit, true);
    assert.strictEqual(quota?.windows[1].usageAllowedAfterLimit, false);
  });

  test("preserves unknown buckets after known buckets in sorted order", () => {
    const bucket = (used: number) => ({
      entitlementRequests: 10,
      usedRequests: used,
      remainingPercentage: 100 - used * 10,
    });
    const quota = normalizeCopilotAccountQuota(
      quotaSnapshots({
        zeta_requests: bucket(1),
        completions: bucket(2),
        alpha_requests: bucket(3),
        premium_interactions: bucket(4),
        chat: bucket(5),
      }),
      FETCHED_AT
    );

    assert.deepStrictEqual(
      quota?.windows.map((window) => [window.id, window.label, window.kind]),
      [
        [
          "copilot:premium_interactions",
          "Premium interactions",
          HARNESS_USAGE_WINDOW_KINDS.MONTHLY,
        ],
        ["copilot:chat", "Chat", HARNESS_USAGE_WINDOW_KINDS.MONTHLY],
        [
          "copilot:completions",
          "Completions",
          HARNESS_USAGE_WINDOW_KINDS.MONTHLY,
        ],
        [
          "copilot:alpha_requests",
          "Alpha Requests",
          HARNESS_USAGE_WINDOW_KINDS.UNKNOWN,
        ],
        [
          "copilot:zeta_requests",
          "Zeta Requests",
          HARNESS_USAGE_WINDOW_KINDS.UNKNOWN,
        ],
      ]
    );
  });

  test("accepts additive fields and snake-case wire keys", () => {
    const quota = normalizeCopilotAccountQuota(
      quotaSnapshots({
        premium_interactions: {
          entitlement_requests: "100",
          used_requests: "25",
          remaining_percentage: 75,
          reset_date: "2026-09-01T00:00:00.000Z",
          hasQuota: true,
          tokenBasedBilling: false,
          overageEntitlement: 10,
        },
      }),
      FETCHED_AT
    );

    assert.strictEqual(quota?.windows[0].used, 25);
    assert.strictEqual(quota?.windows[0].remaining, 75);
  });

  test("drops a resetDate that is not after the fetch time but keeps the bucket", () => {
    const quota = normalizeCopilotAccountQuota(
      quotaSnapshots({
        premium_interactions: {
          entitlementRequests: 7_000,
          usedRequests: 4_144,
          remainingPercentage: 40.8,
          resetDate: new Date(FETCHED_AT - 1_000).toISOString(),
        },
      }),
      FETCHED_AT
    );

    const window = quota?.windows[0];
    assert.strictEqual(window?.used, 4_144);
    assert.strictEqual(window?.limit, 7_000);
    assert.strictEqual(window?.resetAt, undefined);
  });

  test("drops a resetDate equal to the fetch time but keeps the bucket", () => {
    const quota = normalizeCopilotAccountQuota(
      quotaSnapshots({
        premium_interactions: {
          entitlementRequests: 7_000,
          usedRequests: 4_144,
          remainingPercentage: 40.8,
          resetDate: new Date(FETCHED_AT).toISOString(),
        },
      }),
      FETCHED_AT
    );

    assert.strictEqual(quota?.windows[0].resetAt, undefined);
  });

  test("rejects malformed buckets without discarding valid buckets", () => {
    const quota = normalizeCopilotAccountQuota(
      quotaSnapshots({
        valid: {
          entitlementRequests: 10,
          usedRequests: 1,
          remainingPercentage: 90,
        },
        nan_used: {
          entitlementRequests: 10,
          usedRequests: Number.NaN,
          remainingPercentage: 90,
        },
        infinite_limit: {
          entitlementRequests: Number.POSITIVE_INFINITY,
          usedRequests: 1,
          remainingPercentage: 90,
        },
        negative_used: {
          entitlementRequests: 10,
          usedRequests: -1,
          remainingPercentage: 100,
        },
        invalid_date: {
          entitlementRequests: 10,
          usedRequests: 1,
          remainingPercentage: 90,
          resetDate: "not-a-date",
        },
        missing_record: undefined,
      }),
      FETCHED_AT
    );

    assert.deepStrictEqual(
      quota?.windows.map((window) => window.id),
      ["copilot:valid"]
    );
  });

  test("rejects missing quota records and non-object payloads", () => {
    assert.strictEqual(normalizeCopilotAccountQuota(undefined), undefined);
    assert.strictEqual(normalizeCopilotAccountQuota([]), undefined);
    assert.strictEqual(
      normalizeCopilotAccountQuota({ quotaSnapshots: [] }),
      undefined
    );
    assert.strictEqual(
      normalizeCopilotAccountQuota({ quotaSnapshots: {} }),
      undefined
    );
    assert.strictEqual(
      normalizeCopilotAccountQuota(
        quotaSnapshots({ missing: {}, invalid: null }),
        FETCHED_AT
      ),
      undefined
    );
  });

  test("returns undefined when every bucket is invalid", () => {
    assert.strictEqual(
      normalizeCopilotAccountQuota(
        quotaSnapshots({
          invalid: {
            entitlementRequests: 10,
            usedRequests: Number.NaN,
            remainingPercentage: 90,
          },
        }),
        FETCHED_AT
      ),
      undefined
    );
  });
});
