import * as assert from "assert";
import { suite, test } from "mocha";
import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_UNITS,
  HARNESS_USAGE_WINDOW_KINDS,
} from "../../types/DashboardConstants";
import type {
  HarnessQuotaSnapshot,
  HarnessUsageWindow,
} from "../../types/UsageTypes";
import {
  isHarnessQuotaStale,
  isHarnessUsageWindowStale,
} from "../../types/UsageTypes";

suite("UsageTypes staleness", () => {
  const fetchedAt = 1_000_000_000_000;
  const staleAfterMs = 5 * 60 * 1000;

  function quota(windows: HarnessUsageWindow[]): HarnessQuotaSnapshot {
    return {
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
      fetchedAt,
      staleAfterMs,
      windows,
    };
  }

  function window(overrides: Partial<HarnessUsageWindow>): HarnessUsageWindow {
    return {
      id: "five-hour",
      kind: HARNESS_USAGE_WINDOW_KINDS.ROLLING,
      label: "5-hour",
      percentUsed: 50,
      unit: HARNESS_USAGE_UNITS.PERCENT,
      confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
      ...overrides,
    };
  }

  test("a sibling window's early reset no longer marks the whole snapshot stale", () => {
    const fiveHour = window({ id: "five-hour", resetAt: fetchedAt + 60_000 });
    const sevenDay = window({
      id: "seven-day",
      resetAt: fetchedAt + 999_999_999,
    });
    const snapshot = quota([fiveHour, sevenDay]);

    // Past the five-hour window's own reset, but well within staleAfterMs and
    // nowhere near the seven-day window's reset.
    const now = fetchedAt + 120_000;

    assert.strictEqual(isHarnessQuotaStale(snapshot, now), false);
    assert.strictEqual(
      isHarnessUsageWindowStale(snapshot, fiveHour, now),
      true
    );
    assert.strictEqual(
      isHarnessUsageWindowStale(snapshot, sevenDay, now),
      false
    );
  });

  test("a window without its own reset still inherits snapshot-clock staleness", () => {
    const noReset = window({ id: "seven-day" });
    const snapshot = quota([noReset]);

    assert.strictEqual(
      isHarnessUsageWindowStale(snapshot, noReset, fetchedAt + staleAfterMs),
      true
    );
    assert.strictEqual(
      isHarnessUsageWindowStale(
        snapshot,
        noReset,
        fetchedAt + staleAfterMs - 1
      ),
      false
    );
  });
});
