import { render } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { UsageCard } from "@components/settings/stats/UsageCard";
import {
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

  it("preserves Copilot request counts in used mode", () => {
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

    expect(container).toHaveTextContent("555 used requests");
    expect(container).not.toHaveTextContent("555 / 1,500");
  });

  it("preserves Copilot remaining request counts in remaining mode", () => {
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

    expect(container).toHaveTextContent("945 remaining requests");
    expect(container).not.toHaveTextContent("25% remaining");
  });
});
