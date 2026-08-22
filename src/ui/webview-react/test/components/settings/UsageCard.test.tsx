import { render } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { UsageCard } from "@components/settings/stats/UsageCard";
import {
  ATTEMPT_COST_SOURCES,
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_UNITS,
  HARNESS_USAGE_WINDOW_KINDS,
} from "@root/types/DashboardConstants";
import type { HarnessId } from "@root/types/DashboardConstants";
import type { HarnessUsageSnapshot } from "@root/types/UsageTypes";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { UsagePercentDirection } from "@root/utils/StatuslineFormat";
import { useSettingsStore } from "@store/settingsStore";

function makeSnapshot(
  harnessId: HarnessId,
  unit: (typeof HARNESS_USAGE_UNITS)[keyof typeof HARNESS_USAGE_UNITS] = HARNESS_USAGE_UNITS.PERCENT
): HarnessUsageSnapshot {
  const isPercent = unit === HARNESS_USAGE_UNITS.PERCENT;
  return {
    harnessId,
    updatedAt: Date.now(),
    quota: {
      harnessId,
      source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
      staleAfterMs: 60_000,
      windows: [
        {
          id: "weekly",
          kind: HARNESS_USAGE_WINDOW_KINDS.WEEKLY,
          label: "week",
          used: isPercent ? 75 : 555,
          limit: isPercent ? 100 : 1_500,
          remaining: isPercent ? 25 : 945,
          percentUsed: 75,
          unit,
          confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
        },
      ],
    },
    observed: {},
  };
}

function setPercentDirection(direction: UsagePercentDirection) {
  useSettingsStore.setState({
    fullGlobalSettings: {
      settings: {
        ...CTRLYOKE_SETTINGS_DEFAULTS,
        usageTracking: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.usageTracking,
          percentDirection: direction,
        },
      },
      sources: {},
      isMultiRoot: false,
    },
  });
}

describe("UsageCard percent direction", () => {
  beforeEach(() => {
    setPercentDirection("used");
  });

  it("labels percent quota as used by default", () => {
    const { container } = render(
      <UsageCard
        harnessId={HARNESS_IDS.CLAUDE_CLI}
        snapshot={makeSnapshot(
          HARNESS_IDS.CLAUDE_CLI,
          HARNESS_USAGE_UNITS.PERCENT
        )}
        hideCost={true}
      />
    );

    expect(container).toHaveTextContent("75% used");
    expect(container).not.toHaveTextContent("25% remaining");
  });

  it("labels percent quota as remaining when configured", () => {
    setPercentDirection("remaining");
    const { container } = render(
      <UsageCard
        harnessId={HARNESS_IDS.ANTIGRAVITY_CLI}
        snapshot={makeSnapshot(
          HARNESS_IDS.ANTIGRAVITY_CLI,
          HARNESS_USAGE_UNITS.PERCENT
        )}
        hideCost={true}
      />
    );

    expect(container).toHaveTextContent("25% remaining");
    expect(container).not.toHaveTextContent("75% used");
  });

  it("shows Copilot used requests against the entitlement total in used mode", () => {
    const { container } = render(
      <UsageCard
        harnessId={HARNESS_IDS.COPILOT_CLI}
        snapshot={makeSnapshot(
          HARNESS_IDS.COPILOT_CLI,
          HARNESS_USAGE_UNITS.REQUESTS
        )}
        hideCost={true}
      />
    );

    expect(container).toHaveTextContent("555 / 1500 used requests");
  });

  it("shows Copilot remaining requests against the entitlement total in remaining mode", () => {
    setPercentDirection("remaining");
    const { container } = render(
      <UsageCard
        harnessId={HARNESS_IDS.COPILOT_CLI}
        snapshot={makeSnapshot(
          HARNESS_IDS.COPILOT_CLI,
          HARNESS_USAGE_UNITS.REQUESTS
        )}
        hideCost={true}
      />
    );

    expect(container).toHaveTextContent("945 / 1500 remaining requests");
    expect(container).not.toHaveTextContent("25% remaining");
  });

  it("shows the estimated list-price cost for Copilot with a spend-may-differ note", () => {
    const snapshot = makeSnapshot(
      HARNESS_IDS.COPILOT_CLI,
      HARNESS_USAGE_UNITS.CREDITS
    );
    snapshot.observed.monthly = {
      input: 1_000,
      output: 1_000,
      total: 2_000,
      since: Date.now(),
      costUsd: 12.34,
      costSources: [ATTEMPT_COST_SOURCES.PRICE_TABLE],
    };

    const { container } = render(
      <UsageCard
        harnessId={HARNESS_IDS.COPILOT_CLI}
        snapshot={snapshot}
        hideCost={false}
      />
    );

    expect(container).toHaveTextContent("Observed token value: ≈$12.34");
    expect(container).toHaveTextContent(
      "actual AI credit/premium request spend may be lower"
    );
  });

  it("fills the usage bar to the used percentage in used mode", () => {
    const { container } = render(
      <UsageCard
        harnessId={HARNESS_IDS.CLAUDE_CLI}
        snapshot={makeSnapshot(
          HARNESS_IDS.CLAUDE_CLI,
          HARNESS_USAGE_UNITS.PERCENT
        )}
        hideCost={true}
      />
    );

    const bar = container.querySelector(".bg-ctx-bar-track > div");
    expect(bar).toHaveStyle({ width: "75%" });
  });

  it("inverts the usage bar fill in remaining mode", () => {
    setPercentDirection("remaining");
    const { container } = render(
      <UsageCard
        harnessId={HARNESS_IDS.CLAUDE_CLI}
        snapshot={makeSnapshot(
          HARNESS_IDS.CLAUDE_CLI,
          HARNESS_USAGE_UNITS.PERCENT
        )}
        hideCost={true}
      />
    );

    const bar = container.querySelector(".bg-ctx-bar-track > div");
    expect(bar).toHaveStyle({ width: "25%" });
  });
});
