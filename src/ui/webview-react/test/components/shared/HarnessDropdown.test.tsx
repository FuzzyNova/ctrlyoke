import { afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HarnessDropdown } from "@components/shared/HarnessDropdown";
import {
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_UNITS,
  HARNESS_USAGE_WINDOW_KINDS,
  HARNESS_STATUS_STRINGS,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import { HarnessPreflightPanel } from "@components/layout/HarnessPreflightPanel";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useHarnessUsageStore } from "@store/harnessUsageStore";

const originalHarnessStatus = useSettingsStore.getState().harnessStatus;
const { notifyUserMock } = vi.hoisted(() => ({ notifyUserMock: vi.fn() }));

vi.mock("@utils/notifyUser", () => ({ notifyUser: notifyUserMock }));

afterEach(() => {
  useSettingsStore.setState({ harnessStatus: originalHarnessStatus });
  useUiStore.getState().setHarnessDetectionRetryResult(null);
  useHarnessUsageStore.setState({ snapshotsByHarness: {} });
});

describe("HarnessDropdown", () => {
  it("renders the hidden toggle after inline options", () => {
    const { container } = render(
      <HarnessDropdown
        value={HARNESS_IDS.COPILOT_CLI}
        onChange={vi.fn()}
        hiddenValues={[HARNESS_IDS.CLAUDE_CLI]}
        inline
      />
    );

    const wrapper = container.firstElementChild;
    expect(wrapper?.lastElementChild?.textContent).toContain("Show hidden");
  });

  it("shows an unavailable harness install hint on hover", () => {
    render(
      <HarnessDropdown
        value={HARNESS_IDS.COPILOT_CLI}
        onChange={vi.fn()}
        harnessStatus={{
          [HARNESS_IDS.COPILOT_CLI]: {
            available: false,
            status: HARNESS_STATUS_STRINGS.UNAVAILABLE,
            installHint: "Install via: npm install -g @github/copilot",
          },
        }}
      />
    );

    expect(
      screen.getByTitle("Install via: npm install -g @github/copilot")
    ).toBeInTheDocument();
  });

  it("shows retry only for an unavailable selected harness", () => {
    const { rerender } = render(
      <HarnessDropdown
        value={HARNESS_IDS.COPILOT_CLI}
        onChange={vi.fn()}
        harnessStatus={{
          [HARNESS_IDS.COPILOT_CLI]: {
            available: true,
            status: HARNESS_STATUS_STRINGS.AVAILABLE,
          },
        }}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Retry harness detection" })
    ).toBeNull();

    rerender(
      <HarnessDropdown
        value={HARNESS_IDS.COPILOT_CLI}
        onChange={vi.fn()}
        harnessStatus={{
          [HARNESS_IDS.COPILOT_CLI]: {
            available: false,
            status: HARNESS_STATUS_STRINGS.UNAVAILABLE,
          },
        }}
      />
    );

    expect(
      screen.getByRole("button", { name: "Retry harness detection" })
    ).toBeInTheDocument();
  });

  it("shows pending state and reports a successful retry", async () => {
    render(
      <HarnessDropdown
        value={HARNESS_IDS.COPILOT_CLI}
        onChange={vi.fn()}
        harnessStatus={{
          [HARNESS_IDS.COPILOT_CLI]: {
            available: false,
            status: HARNESS_STATUS_STRINGS.UNAVAILABLE,
          },
        }}
      />
    );

    const retryButton = screen.getByRole("button", {
      name: "Retry harness detection",
    });
    fireEvent.click(retryButton);

    expect(
      screen.getByRole("button", { name: "Retrying harness detection" })
    ).toBeDisabled();
    const calls = vi.mocked(window.vscodeApi!.postMessage).mock.calls;
    const request = calls[calls.length - 1]?.[0] as {
      type: string;
      requestId: string;
    };
    expect(request.type).toBe(MESSAGE_TYPES.RETRY_HARNESS_DETECTION);

    useUiStore.getState().setHarnessDetectionRetryResult({
      requestId: request.requestId,
      success: true,
    });

    await waitFor(() => {
      expect(notifyUserMock).toHaveBeenCalledWith(
        "Harness detection retry completed",
        "success"
      );
    });
    expect(
      screen.getByRole("button", { name: "Retry harness detection" })
    ).toBeEnabled();
  });

  it("reports a failed retry and clears pending state", async () => {
    render(
      <HarnessDropdown
        value={HARNESS_IDS.COPILOT_CLI}
        onChange={vi.fn()}
        harnessStatus={{
          [HARNESS_IDS.COPILOT_CLI]: {
            available: false,
            status: HARNESS_STATUS_STRINGS.UNAVAILABLE,
          },
        }}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Retry harness detection" })
    );
    const calls = vi.mocked(window.vscodeApi!.postMessage).mock.calls;
    const request = calls[calls.length - 1]?.[0] as {
      requestId: string;
    };
    useUiStore.getState().setHarnessDetectionRetryResult({
      requestId: request.requestId,
      success: false,
      error: "CLI not installed",
    });

    await waitFor(() => {
      expect(notifyUserMock).toHaveBeenCalledWith("CLI not installed", "error");
    });
    expect(
      screen.getByRole("button", { name: "Retry harness detection" })
    ).toBeEnabled();
  });

  it("shows no status text, just a combined tooltip, when a harness is available with no usage data", () => {
    render(
      <HarnessDropdown
        value={HARNESS_IDS.CLAUDE_CLI}
        onChange={vi.fn()}
        harnessStatus={{
          [HARNESS_IDS.CLAUDE_CLI]: { available: true, status: "available" },
        }}
        inline
      />
    );

    expect(screen.queryByText("Available")).not.toBeInTheDocument();
    expect(screen.getByTitle("Available | No usage data")).toBeInTheDocument();
  });

  it("shows a percentage badge before the status dot when usage data exists", () => {
    // The badge is hidden below a 180px measured width; jsdom reports 0 by
    // default, so stub a wide layout for this assertion.
    const originalGetBoundingClientRect =
      Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (
      this: Element
    ): DOMRect {
      return { width: 300, height: 20 } as DOMRect;
    };

    useHarnessUsageStore.setState({
      snapshotsByHarness: {
        [HARNESS_IDS.CLAUDE_CLI]: {
          harnessId: HARNESS_IDS.CLAUDE_CLI,
          updatedAt: Date.now(),
          quota: {
            harnessId: HARNESS_IDS.CLAUDE_CLI,
            source: HARNESS_QUOTA_SOURCES.PROVIDER_LIVE,
            fetchedAt: Date.now(),
            staleAfterMs: 5 * 60 * 1000,
            windows: [
              {
                id: "5h",
                kind: HARNESS_USAGE_WINDOW_KINDS.ROLLING,
                label: "5-hour",
                percentUsed: 25,
                unit: HARNESS_USAGE_UNITS.PERCENT,
                confidence: HARNESS_USAGE_CONFIDENCE.EXACT,
              },
            ],
          },
          observed: {},
        },
      },
    });

    try {
      render(
        <HarnessDropdown
          value={HARNESS_IDS.CLAUDE_CLI}
          onChange={vi.fn()}
          harnessStatus={{
            [HARNESS_IDS.CLAUDE_CLI]: { available: true, status: "available" },
          }}
          inline
        />
      );

      expect(screen.getByText("25%")).toBeInTheDocument();
      expect(screen.getByTitle("Available | 25% 5-hour")).toBeInTheDocument();
    } finally {
      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it("shows preflight guidance only when every harness is unavailable", () => {
    useSettingsStore.setState({
      harnessStatus: Object.fromEntries(
        Object.values(HARNESS_IDS).map((id) => [
          id,
          {
            available: false,
            status: "unavailable",
            installHint: `Install ${id}`,
          },
        ])
      ) as typeof originalHarnessStatus,
    });

    render(<HarnessPreflightPanel />);

    expect(
      screen.getByText("No AI harness CLI is available")
    ).toBeInTheDocument();
    expect(screen.getByText("Install codex-cli")).toBeInTheDocument();
  });
});
