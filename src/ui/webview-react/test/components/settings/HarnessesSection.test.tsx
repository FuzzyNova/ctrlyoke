import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { HarnessesSection } from "@components/settings/HarnessesSection";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import { HARNESS_IDS, SETTING_SCOPES } from "@root/types/DashboardConstants";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function settings(): FullGlobalSettings {
  return { settings: CTRLYOKE_SETTINGS_DEFAULTS, sources: {}, isMultiRoot: false };
}

describe("HarnessesSection usage cards", () => {
  beforeEach(() => {
    useHarnessUsageStore.setState({ snapshotsByHarness: {} });
  });

  it("labels observed-only quota separately and does not render a fake window", () => {
    useHarnessUsageStore.getState().setSnapshots([
      {
        harnessId: HARNESS_IDS.QWEN_CLI,
        updatedAt: Date.now(),
        quota: {
          harnessId: HARNESS_IDS.QWEN_CLI,
          source: "unavailable",
          staleAfterMs: 0,
          windows: [],
        },
        observed: {
          daily: { input: 3, output: 4, total: 7, since: Date.now() },
        },
      },
    ]);

    render(
      <HarnessesSection
        settings={settings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => undefined}
        onReset={() => undefined}
      />
    );

    expect(screen.getAllByText("Quota source: observed only").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ctrlyoke-observed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("7 tokens").length).toBeGreaterThan(0);
    expect(screen.queryByText(/resets/i)).not.toBeInTheDocument();
  });
});
