import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StatsUsageSection } from "@components/settings/stats/StatsUsageSection";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import { useWorkspaceStatsStore } from "@store/workspaceStatsStore";
import {
  HARNESS_IDS,
  HARNESS_INFO,
  MESSAGE_TYPES,
  SETTING_PATHS,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function createSettings(
  usageTracking: Partial<typeof CTRLYOKE_SETTINGS_DEFAULTS.usageTracking> = {}
): FullGlobalSettings {
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      usageTracking: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.usageTracking,
        ...usageTracking,
      },
    },
    sources: {},
    isMultiRoot: false,
  };
}

describe("StatsUsageSection", () => {
  beforeEach(() => {
    useHarnessUsageStore.setState({ snapshotsByHarness: {} });
    useWorkspaceStatsStore.setState({ snapshot: undefined });
    vi.mocked(getVsCodeApi().postMessage).mockClear();
  });

  it("renders the moved usage cards and requests usage on mount", () => {
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
      <StatsUsageSection
        showCostEstimates={true}
        activeScope={SETTING_SCOPES.USER}
      />
    );

    expect(screen.getByText("Workspace statistics")).toBeInTheDocument();
    expect(screen.getByText("This workspace only")).toBeInTheDocument();
    expect(
      screen.getByText(HARNESS_INFO[HARNESS_IDS.QWEN_CLI].name)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent === "Quota source: not reported by provider"
      )
    ).toBeInTheDocument();
    expect(screen.getByText("7 tokens")).toBeInTheDocument();
    expect(screen.queryByText(/resets/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Totals are ctrlyoke-observed only; they do not include harness activity outside ctrlyoke\. Costs are estimated from token counts at API list prices, or taken directly from a harness's own reported figure when one is available; either way, they are not subscription spend\./
      )
    ).toBeInTheDocument();

    const postMessage = vi.mocked(getVsCodeApi().postMessage);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REQUEST_WORKSPACE_STATS,
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REQUEST_HARNESS_USAGE,
    });
  });

  it("refreshes harness usage from the page button", async () => {
    const user = userEvent.setup();
    render(
      <StatsUsageSection
        showCostEstimates={false}
        activeScope={SETTING_SCOPES.USER}
      />
    );

    vi.mocked(getVsCodeApi().postMessage).mockClear();
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REFRESH_WORKSPACE_STATS,
    });
  });

  it("formats large observed token counts compactly", () => {
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
          daily: {
            input: 500,
            output: 1_000,
            total: 1_500,
            since: Date.now(),
          },
        },
      },
    ]);

    render(
      <StatsUsageSection
        showCostEstimates={true}
        activeScope={SETTING_SCOPES.USER}
      />
    );

    expect(screen.getByText("1.5k tokens")).toBeInTheDocument();
  });

  it("renders the usage collection controls", () => {
    render(
      <StatsUsageSection
        showCostEstimates={true}
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Usage collection" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /^Track harness usage/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /^Refresh quota from provider/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /^Save usage history/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", {
        name: "Usage warning threshold, property usageTracking.warningPercentUsed",
      })
    ).toBeInTheDocument();
  });

  it("updates each usage collection setting through the section callback", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    render(
      <StatsUsageSection
        showCostEstimates={true}
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("checkbox", { name: /^Track harness usage/ })
    );
    await user.click(
      screen.getByRole("checkbox", { name: /^Refresh quota from provider/ })
    );
    await user.click(
      screen.getByRole("checkbox", { name: /^Save usage history/ })
    );
    const threshold = screen.getByRole("spinbutton", {
      name: "Usage warning threshold, property usageTracking.warningPercentUsed",
    });
    await user.clear(threshold);
    await user.type(threshold, "95");
    await user.tab();

    expect(onUpdate).toHaveBeenNthCalledWith(1, "usageTracking.enabled", false);
    expect(onUpdate).toHaveBeenNthCalledWith(
      2,
      "usageTracking.providerRefreshEnabled",
      false
    );
    expect(onUpdate).toHaveBeenNthCalledWith(
      3,
      "usageTracking.persistObservedUsage",
      false
    );
    expect(onUpdate).toHaveBeenNthCalledWith(
      4,
      "usageTracking.warningPercentUsed",
      95
    );
  });

  it("disables usage collection at workspace scope with a user-scope note", () => {
    render(
      <StatsUsageSection
        showCostEstimates={true}
        settings={createSettings()}
        activeScope={SETTING_SCOPES.WORKSPACE}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(
      screen.getByRole("checkbox", { name: /^Track harness usage/ })
    ).toBeDisabled();
    expect(
      screen.getByText(
        /user-scoped and cannot be changed from workspace scope/i
      )
    ).toBeInTheDocument();
  });

  it("disables provider refresh and persistence when collection is disabled", () => {
    render(
      <StatsUsageSection
        showCostEstimates={true}
        settings={createSettings({ enabled: false })}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(
      screen.getByRole("checkbox", { name: /^Track harness usage/ })
    ).not.toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: /^Refresh quota from provider/ })
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: /^Save usage history/ })
    ).toBeDisabled();
  });

  it("does not render statusline tracking controls", () => {
    render(
      <StatsUsageSection
        showCostEstimates={true}
        activeScope={SETTING_SCOPES.USER}
      />
    );

    expect(screen.queryByText("Statusline Tracking")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", {
        name: /^Custom statusline command, property /,
      })
    ).not.toBeInTheDocument();
  });

  it("writes the global percent direction setting at the active scope", async () => {
    const user = userEvent.setup();
    render(
      <StatsUsageSection
        showCostEstimates={true}
        activeScope={SETTING_SCOPES.WORKSPACE}
      />
    );

    await user.click(screen.getByRole("button", { name: "Remaining" }));

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path: SETTING_PATHS.USAGE_TRACKING_PERCENT_DIRECTION,
      value: "remaining",
      scope: SETTING_SCOPES.WORKSPACE,
    });
  });
});
