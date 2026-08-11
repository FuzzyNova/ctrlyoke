import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StatsUsageSection } from "@components/settings/stats/StatsUsageSection";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import {
  HARNESS_IDS,
  HARNESS_INFO,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";

describe("StatsUsageSection", () => {
  beforeEach(() => {
    useHarnessUsageStore.setState({ snapshotsByHarness: {} });
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

    render(<StatsUsageSection hideCost={false} />);

    expect(screen.getByText("Workspace statistics")).toBeInTheDocument();
    expect(screen.getByText("This workspace only")).toBeInTheDocument();
    expect(
      screen.getByText(HARNESS_INFO[HARNESS_IDS.QWEN_CLI].name)
    ).toBeInTheDocument();
    expect(screen.getByText("Quota source: observed only")).toBeInTheDocument();
    expect(screen.getByText("ctrlyoke-observed")).toBeInTheDocument();
    expect(screen.getByText("7 tokens")).toBeInTheDocument();
    expect(screen.queryByText(/resets/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Totals are ctrlyoke-observed only; they do not include harness activity outside ctrlyoke\. Costs are estimates at API list prices, not subscription spend\./
      )
    ).toBeInTheDocument();

    const postMessage = vi.mocked(getVsCodeApi().postMessage);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REQUEST_HARNESS_USAGE,
    });
  });

  it("refreshes harness usage from the page button", async () => {
    const user = userEvent.setup();
    render(<StatsUsageSection hideCost={true} />);

    vi.mocked(getVsCodeApi().postMessage).mockClear();
    await user.click(
      screen.getByRole("button", { name: "Refresh harness usage" })
    );

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REFRESH_HARNESS_USAGE,
    });
  });
});
