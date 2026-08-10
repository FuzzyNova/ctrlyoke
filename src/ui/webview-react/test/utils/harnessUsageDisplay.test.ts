import { describe, it, expect } from "vitest";
import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_UNITS,
  HARNESS_USAGE_WINDOW_KINDS,
} from "@root/types/DashboardConstants";
import type { HarnessUsageSnapshot } from "@root/types/UsageTypes";
import { getHarnessUsageDisplay } from "@utils/harnessUsageDisplay";

function snapshot(
  windows: HarnessUsageSnapshot["quota"]["windows"],
  fetchedAt: number
): HarnessUsageSnapshot {
  return {
    harnessId: HARNESS_IDS.CLAUDE_CLI,
    updatedAt: fetchedAt,
    quota: {
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
      fetchedAt,
      staleAfterMs: 5 * 60 * 1000,
      windows,
    },
    observed: {},
  };
}

describe("getHarnessUsageDisplay", () => {
  const fetchedAt = 1_000_000_000_000;
  const window = {
    id: "five-hour",
    kind: HARNESS_USAGE_WINDOW_KINDS.ROLLING,
    label: "5-hour",
    percentUsed: 63,
    unit: HARNESS_USAGE_UNITS.PERCENT,
    confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
  };

  it("shows the last-known percentage unannotated while fresh", () => {
    const display = getHarnessUsageDisplay(
      snapshot([window], fetchedAt),
      fetchedAt + 60_000
    );
    expect(display.percentOnly).toBe("63%");
    expect(display.quotaPhrase).toBe("63% 5-hour");
  });

  it("keeps showing the last-known percentage past the freshness window, annotated stale", () => {
    const display = getHarnessUsageDisplay(
      snapshot([window], fetchedAt),
      fetchedAt + 5 * 60 * 1000 + 1
    );
    expect(display.percentOnly).toBe("63%");
    expect(display.quotaPhrase).toBe("63% 5-hour (stale)");
  });

  it("annotates only the window whose own reset has passed, not a fresh sibling window", () => {
    const fiveHour = { ...window, id: "five-hour", resetAt: fetchedAt + 60_000 };
    const sevenDay = {
      ...window,
      id: "seven-day",
      label: "7-day",
      percentUsed: 10,
      resetAt: fetchedAt + 999_999_999,
    };
    const display = getHarnessUsageDisplay(
      snapshot([fiveHour, sevenDay], fetchedAt),
      fetchedAt + 120_000
    );
    expect(display.quotaPhrase).toBe("63% 5-hour (stale) | 10% 7-day");
  });

  it("falls back to a stale label with no numbers when no window ever reported a percentage", () => {
    const display = getHarnessUsageDisplay(
      snapshot([], fetchedAt),
      fetchedAt + 5 * 60 * 1000 + 1
    );
    expect(display.percentOnly).toBeUndefined();
    expect(display.quotaPhrase).toBe("Usage data stale");
  });
});
