import * as assert from "assert";
import { suite, test } from "mocha";
import {
  AntigravityUsageProvider,
  parseAntigravityQuotaSnapshot,
} from "../../core/harness/shared/usage/providers/AntigravityUsageProvider";
import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_STATUS_CODES,
  HARNESS_USAGE_UNITS,
  HARNESS_USAGE_WINDOW_KINDS,
} from "../../types/DashboardConstants";

suite("AntigravityUsageProvider", () => {
  test("normalizes dynamic quota tiers without hardcoded plan names", () => {
    const quota = parseAntigravityQuotaSnapshot(
      {
        quota: {
          "3p-weekly": {
            remaining_fraction: 0.25,
            reset_time: "2026-08-21T12:34:56.000Z",
          },
          "gemini-weekly": { remaining_fraction: 1 },
          "studio-daily": {
            remaining_fraction: 0.5,
            reset_time: 1_800_000_000,
          },
        },
      },
      1_700_000_000_000
    );

    assert.ok(quota);
    assert.strictEqual(quota.harnessId, HARNESS_IDS.ANTIGRAVITY_CLI);
    assert.strictEqual(quota.source, HARNESS_QUOTA_SOURCES.PROVIDER_LIVE);
    assert.strictEqual(quota.fetchedAt, 1_700_000_000_000);
    assert.strictEqual(quota.staleAfterMs > 0, true);
    assert.deepStrictEqual(
      quota.windows.map((window) => [window.id, window.label, window.kind]),
      [
        ["3p-weekly", "3P Weekly", HARNESS_USAGE_WINDOW_KINDS.WEEKLY],
        ["gemini-weekly", "Gemini Weekly", HARNESS_USAGE_WINDOW_KINDS.WEEKLY],
        ["studio-daily", "Studio Daily", HARNESS_USAGE_WINDOW_KINDS.DAILY],
      ]
    );

    assert.deepStrictEqual(quota.windows[0], {
      id: "3p-weekly",
      kind: HARNESS_USAGE_WINDOW_KINDS.WEEKLY,
      label: "3P Weekly",
      used: 75,
      limit: 100,
      remaining: 25,
      percentUsed: 75,
      resetAt: Date.parse("2026-08-21T12:34:56.000Z"),
      unit: HARNESS_USAGE_UNITS.PERCENT,
      confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
    });
    assert.strictEqual(quota.windows[2].resetAt, 1_800_000_000_000);
  });

  test("drops malformed tiers and timestamps while keeping valid siblings", () => {
    const quota = parseAntigravityQuotaSnapshot(
      {
        quota: {
          valid: { remaining_fraction: 0.9, reset_time: "not-a-date" },
          "too-low": { remaining_fraction: -0.1 },
          "too-high": { remaining_fraction: 1.1 },
          "not-a-number": { remaining_fraction: "unknown" },
          missing: {},
          nonObject: null,
        },
      },
      "2026-08-20T00:00:00.000Z"
    );

    assert.ok(quota);
    assert.deepStrictEqual(
      quota.windows.map((window) => window.id),
      ["valid"]
    );
    assert.strictEqual(quota.windows[0].resetAt, undefined);
  });

  test("returns an explicit unavailable pull result because quota is sidecar-pushed", async () => {
    const quota = await new AntigravityUsageProvider().refreshUsage();

    assert.deepStrictEqual(quota, {
      harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
      source: HARNESS_QUOTA_SOURCES.UNAVAILABLE,
      staleAfterMs: 0,
      windows: [],
      errorCode: HARNESS_USAGE_STATUS_CODES.SIDECAR_PENDING,
    });
  });
});
