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

  it("annotates the last-known percentage with when it was fetched, while fresh", () => {
    const display = getHarnessUsageDisplay(
      snapshot([window], fetchedAt),
      fetchedAt + 60_000
    );
    expect(display.percentOnly).toBe("63%");
    expect(display.quotaPhrase).toMatch(/^63% 5-hour \(updated .+\)$/);
    expect(display.quotaPhrase).not.toContain("stale");
  });

  it("keeps showing the last-known percentage past the freshness window, still annotated with the fetch time rather than 'stale'", () => {
    const display = getHarnessUsageDisplay(
      snapshot([window], fetchedAt),
      fetchedAt + 5 * 60 * 1000 + 1
    );
    expect(display.percentOnly).toBe("63%");
    expect(display.quotaPhrase).toMatch(/^63% 5-hour \(updated .+\)$/);
    expect(display.quotaPhrase).not.toContain("stale");
  });

  it("drops the reset time only for the window whose own reset has passed, not a fresh sibling window", () => {
    const fiveHour = {
      ...window,
      id: "five-hour",
      resetAt: fetchedAt + 60_000,
    };
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
    // The five-hour window's own reset already passed, so its reset time is
    // dropped; the still-live seven-day window keeps its own.
    expect(display.quotaPhrase).toMatch(
      /^63% 5-hour \| 10% 7-day, resets .+ \(updated .+\)$/
    );
  });

  it("shows the fetch time with no numbers when no window ever reported a percentage", () => {
    const display = getHarnessUsageDisplay(
      snapshot([], fetchedAt),
      fetchedAt + 5 * 60 * 1000 + 1
    );
    expect(display.percentOnly).toBeUndefined();
    expect(display.quotaPhrase).toMatch(/^Usage data updated .+$/);
    expect(display.quotaPhrase).not.toContain("stale");
  });

  it("falls back to 'No usage data' when quota was never fetched", () => {
    const neverFetched: HarnessUsageSnapshot = {
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      updatedAt: fetchedAt,
      quota: {
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        source: HARNESS_QUOTA_SOURCES.UNAVAILABLE,
        staleAfterMs: 0,
        windows: [],
      },
      observed: {},
    };
    const display = getHarnessUsageDisplay(neverFetched, fetchedAt);
    expect(display.percentOnly).toBeUndefined();
    expect(display.quotaPhrase).toBe("No usage data");
  });

  it("appends the reset time for a still-live window with a future resetAt", () => {
    const fiveHour = { ...window, resetAt: fetchedAt + 60 * 60 * 1000 };
    const display = getHarnessUsageDisplay(
      snapshot([fiveHour], fetchedAt),
      fetchedAt + 60_000
    );
    expect(display.quotaPhrase).toMatch(
      /^63% 5-hour, resets .+ \(updated .+\)$/
    );
  });

  it("shows provider monthly totals while keeping the compact badge percentage-only", () => {
    const monthly = {
      ...window,
      kind: HARNESS_USAGE_WINDOW_KINDS.MONTHLY,
      label: "monthly",
      percentUsed: 37,
      used: 555,
      limit: 1_500,
      // Copilot's account quota is counted in requests, not percent.
      unit: HARNESS_USAGE_UNITS.REQUESTS,
      resetAt: fetchedAt + 60 * 60 * 1000,
    };
    const display = getHarnessUsageDisplay(
      snapshot([monthly], fetchedAt),
      fetchedAt + 60_000
    );
    expect(display.percentOnly).toBe("37%");
    expect(display.quotaPhrase).toMatch(
      /^Provider quota: 37% monthly used \(555 \/ 1,500\), resets .+ \(updated .+\)$/
    );
    expect(display.quotaPhrase).not.toContain("tokens");
  });

  it("renders an unlimited provider window without inventing a percentage or limit", () => {
    const display = getHarnessUsageDisplay(
      snapshot(
        [
          {
            ...window,
            percentUsed: undefined,
            used: 12,
            limit: undefined,
            isUnlimited: true,
          },
        ],
        fetchedAt
      ),
      fetchedAt + 60_000
    );
    expect(display.percentOnly).toBeUndefined();
    expect(display.quotaPhrase).toMatch(
      /^Provider quota: Unlimited \(updated .+\)$/
    );
  });

  it("does not combine observed token totals with provider quota totals", () => {
    const monthly = {
      ...window,
      kind: HARNESS_USAGE_WINDOW_KINDS.MONTHLY,
      label: "monthly",
      percentUsed: 37,
      used: 555,
      limit: 1_500,
      unit: HARNESS_USAGE_UNITS.REQUESTS,
    };
    const usage = snapshot([monthly], fetchedAt);
    usage.observed = {
      monthly: {
        input: 100_000,
        output: 2_000,
        total: 102_000,
        since: fetchedAt,
      },
    };
    const display = getHarnessUsageDisplay(usage, fetchedAt + 60_000);
    expect(display.quotaPhrase).toContain("Provider quota");
    expect(display.quotaPhrase).toContain("555 / 1,500");
    expect(display.quotaPhrase).not.toContain("102,000");
    expect(display.quotaPhrase).not.toContain("tokens");
  });

  it("omits the reset time once a window's own reset has passed, rather than showing a past reset", () => {
    const fiveHour = { ...window, resetAt: fetchedAt + 60_000 };
    const display = getHarnessUsageDisplay(
      snapshot([fiveHour], fetchedAt),
      fetchedAt + 120_000
    );
    expect(display.quotaPhrase).toMatch(/^63% 5-hour \(updated .+\)$/);
  });

  it("leaves percent-unit windows unchanged, even though they carry used/limit", () => {
    // Claude and Codex both encode a percentage as `used: pct, limit: 100`.
    // Those are not spendable provider counts, so the tooltip must not gain a
    // "(63 / 100)" fragment or the "Provider quota:" prefix.
    const percentWindow = { ...window, used: 63, limit: 100, remaining: 37 };
    const display = getHarnessUsageDisplay(
      snapshot([percentWindow], fetchedAt),
      fetchedAt + 60_000
    );
    expect(display.percentOnly).toBe("63%");
    expect(display.quotaPhrase).toMatch(/^63% 5-hour \(updated .+\)$/);
  });

  it("gives each window its own independent reset time when joined", () => {
    const fiveHour = {
      ...window,
      id: "five-hour",
      resetAt: fetchedAt + 60_000,
    };
    const sevenDay = {
      ...window,
      id: "seven-day",
      label: "7-day",
      percentUsed: 10,
      resetAt: fetchedAt + 999_999_999,
    };
    const display = getHarnessUsageDisplay(
      snapshot([fiveHour, sevenDay], fetchedAt),
      fetchedAt + 30_000
    );
    expect(display.quotaPhrase).toMatch(
      /^63% 5-hour, resets .+ \| 10% 7-day, resets .+ \(updated .+\)$/
    );
  });
});
