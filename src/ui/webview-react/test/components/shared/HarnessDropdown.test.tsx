import { afterEach, describe, it, expect, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { HarnessDropdown } from "@components/shared/HarnessDropdown";
import {
  HARNESS_DISPLAY_ORDER,
  INHERIT_DEFAULT_OPTION,
  PICKER_SHORTCUT_TARGETS,
  type PickerShortcutTarget,
  HARNESS_IDS,
  HARNESS_QUOTA_SOURCES,
  HARNESS_USAGE_CONFIDENCE,
  HARNESS_USAGE_UNITS,
  HARNESS_USAGE_WINDOW_KINDS,
  HARNESS_STATUS_STRINGS,
  HARNESS_VERSION_STATUSES,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import { HarnessPreflightPanel } from "@components/layout/HarnessPreflightPanel";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useHarnessUsageStore } from "@store/harnessUsageStore";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import { STATUS_LINE_USAGE_DIRECTIONS } from "@root/utils/StatuslineFormat";

const originalHarnessStatus = useSettingsStore.getState().harnessStatus;
const originalFullGlobalSettings =
  useSettingsStore.getState().fullGlobalSettings;
const { notifyUserMock } = vi.hoisted(() => ({ notifyUserMock: vi.fn() }));

vi.mock("@utils/notifyUser", () => ({ notifyUser: notifyUserMock }));

afterEach(() => {
  useSettingsStore.setState({ harnessStatus: originalHarnessStatus });
  useSettingsStore.setState({ fullGlobalSettings: originalFullGlobalSettings });
  useUiStore.getState().setHarnessDetectionRetryResult(null);
  useHarnessUsageStore.setState({ snapshotsByHarness: {} });
});

describe("HarnessDropdown", () => {
  it("exposes a named listbox trigger and its controlled listbox", async () => {
    render(
      <HarnessDropdown
        id="harness"
        triggerAriaLabel="Harness"
        value={HARNESS_IDS.COPILOT_CLI}
        onChange={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: /^Harness/ });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls", "harness-listbox");
  });

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
            installCommand: "npm install -g @github/copilot",
          },
        }}
      />
    );

    expect(
      screen.getByTitle(
        "Install via: npm install -g @github/copilot property: harness = copilot-cli"
      )
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
    useSettingsStore.setState({
      fullGlobalSettings: {
        settings: {
          ...CTRLYOKE_SETTINGS_DEFAULTS,
          usageTracking: {
            ...CTRLYOKE_SETTINGS_DEFAULTS.usageTracking,
            percentDirection: STATUS_LINE_USAGE_DIRECTIONS.REMAINING,
          },
        },
        sources: {},
        isMultiRoot: false,
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

      expect(screen.getByText("75%")).toBeInTheDocument();
      expect(
        screen.getByTitle(/^Available \| 75% remaining 5-hour \(updated .+\)$/)
      ).toBeInTheDocument();
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
            installCommand: `Install ${id}`,
          },
        ])
      ) as typeof originalHarnessStatus,
    });

    render(<HarnessPreflightPanel />);

    expect(
      screen.getByText("No CLI coding agent is available")
    ).toBeInTheDocument();
    expect(screen.getByText("Install codex-cli")).toBeInTheDocument();
    // VS Code's default <code> background is paired with its own foreground; the
    // command overrides the foreground, so it must also own the (themed)
    // background or high-contrast light renders dark text on a dark fill.
    expect(screen.getByText("Install codex-cli")).toHaveClass("bg-code-block");
    expect(
      screen.getByRole("button", {
        name: "Copy install command for Codex",
      })
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^Copy install command for / })
    ).toHaveLength(Object.values(HARNESS_IDS).length);
  });

  it("flags a harness below the minimum with a warning dot and update guidance", () => {
    const { container } = render(
      <HarnessDropdown
        value={HARNESS_IDS.COPILOT_CLI}
        onChange={vi.fn()}
        harnessStatus={{
          [HARNESS_IDS.COPILOT_CLI]: {
            available: true,
            status: HARNESS_STATUS_STRINGS.AVAILABLE,
            version: {
              status: HARNESS_VERSION_STATUSES.BELOW_MINIMUM,
              installedVersion: "1.0.10",
              minimumVersion: "1.0.19",
              testedWithVersion: "1.0.92",
              updateCommand: "copilot update",
            },
          },
        }}
      />
    );

    expect(
      container.querySelector('[data-harness-status="below-minimum"]')
    ).not.toBeNull();
    expect(
      screen.getByTitle(
        "Available — Installed version 1.0.10 is older than the minimum supported version 1.0.19 and may not work correctly. Update with: copilot update property: harness = copilot-cli"
      )
    ).toBeInTheDocument();
  });

  it("does not flag a harness that is merely older than the version ctrlyoke was tested with", () => {
    const { container } = render(
      <HarnessDropdown
        value={HARNESS_IDS.COPILOT_CLI}
        onChange={vi.fn()}
        harnessStatus={{
          [HARNESS_IDS.COPILOT_CLI]: {
            available: true,
            status: HARNESS_STATUS_STRINGS.AVAILABLE,
            version: {
              status: HARNESS_VERSION_STATUSES.SUPPORTED,
              installedVersion: "1.0.50",
              minimumVersion: "1.0.19",
              testedWithVersion: "1.0.92",
              updateCommand: "copilot update",
            },
          },
        }}
      />
    );

    expect(
      container.querySelector('[data-harness-status="available"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-harness-status="below-minimum"]')
    ).toBeNull();
  });

  it("shows install commands in preflight for every unavailable harness", () => {
    useSettingsStore.setState({
      harnessStatus: Object.fromEntries(
        Object.values(HARNESS_IDS).map((id) => [
          id,
          {
            available: false,
            status: "unavailable",
            installCommand: `Install ${id}`,
          },
        ])
      ) as typeof originalHarnessStatus,
    });

    render(<HarnessPreflightPanel />);

    expect(screen.getByText("Install codex-cli")).toBeInTheDocument();
    expect(screen.getByText("Install claude-cli")).toBeInTheDocument();
  });
});

describe("HarnessDropdown — picker shortcut and keyboard navigation", () => {
  function press(target: PickerShortcutTarget) {
    act(() => {
      useUiStore.getState().requestPickerShortcut(target, { mobile: false });
    });
  }

  function activeValue() {
    return document
      .querySelector(".cy-dropdown-row-active")
      ?.getAttribute("data-listbox-value");
  }

  afterEach(() => {
    useUiStore.setState({ pickerShortcutRequest: null });
  });

  it("opens on the shortcut, skips unavailable and hidden harnesses, and commits", async () => {
    const onChange = vi.fn();
    render(
      <HarnessDropdown
        value={HARNESS_IDS.CLAUDE_CLI}
        onChange={onChange}
        shortcutTarget={PICKER_SHORTCUT_TARGETS.WORKFLOW_HARNESS}
        hiddenValues={[HARNESS_IDS.COPILOT_CLI]}
        harnessStatus={{
          [HARNESS_IDS.CODEX_CLI]: {
            available: false,
            status: HARNESS_STATUS_STRINGS.UNAVAILABLE,
          },
        }}
      />
    );

    press(PICKER_SHORTCUT_TARGETS.WORKFLOW_HARNESS);
    const listbox = await screen.findByRole("listbox");
    await waitFor(() => expect(listbox).toHaveFocus());
    expect(activeValue()).toBe(HARNESS_IDS.CLAUDE_CLI);

    // Codex (unavailable) and Copilot (hidden) are skipped.
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(activeValue()).toBe(HARNESS_IDS.OPENCODE_CLI);

    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(HARNESS_IDS.OPENCODE_CLI);
  });

  it("includes the Inherit sentinel inline and advances on a repeat press", async () => {
    render(
      <HarnessDropdown
        value={INHERIT_DEFAULT_OPTION}
        onChange={vi.fn()}
        showDefault
        inline
        shortcutTarget={PICKER_SHORTCUT_TARGETS.STEP_HARNESS}
      />
    );

    press(PICKER_SHORTCUT_TARGETS.STEP_HARNESS);
    const listbox = screen.getByRole("listbox");
    await waitFor(() => expect(listbox).toHaveFocus());
    expect(activeValue()).toBe(INHERIT_DEFAULT_OPTION);

    press(PICKER_SHORTCUT_TARGETS.STEP_HARNESS);
    expect(activeValue()).toBe(HARNESS_DISPLAY_ORDER[0]);
  });
});
