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

function makeSnapshot(harnessId: HarnessId): HarnessUsageSnapshot {
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
          used: 75,
          limit: 100,
          remaining: 25,
          percentUsed: 75,
          unit: HARNESS_USAGE_UNITS.PERCENT,
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

  it.each(Object.values(HARNESS_IDS) as HarnessId[])(
    "labels %s quota percentages as used by default",
    (harnessId) => {
      const { container } = render(
        <UsageCard
          harnessId={harnessId}
          snapshot={makeSnapshot(harnessId)}
          hideCost={true}
        />
      );

      expect(container).toHaveTextContent("75% used");
      expect(container).not.toHaveTextContent("25% remaining");
    }
  );

  it.each(Object.values(HARNESS_IDS) as HarnessId[])(
    "labels %s quota percentages as remaining when configured",
    (harnessId) => {
      setPercentDirection("remaining");
      const { container } = render(
        <UsageCard
          harnessId={harnessId}
          snapshot={makeSnapshot(harnessId)}
          hideCost={true}
        />
      );

      expect(container).toHaveTextContent("25% remaining");
      expect(container).not.toHaveTextContent("75% used");
    }
  );
});
