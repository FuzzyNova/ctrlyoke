import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalControlBar } from "@components/output/TerminalControlBar";
import { useSettingsStore } from "@store/settingsStore";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import type {
  TerminalMobileBarLayout,
  TerminalShortcut,
} from "@root/types/CtrlYokeSettings";
import {
  DEFAULT_TERMINAL_BAR_LAYOUT,
  TERMINAL_BAR_CTRL_ID,
  TERMINAL_BAR_KEY_IDS,
  TERMINAL_BAR_SHORTCUT_IDS,
} from "@root/utils/TerminalControlBarFormat";
import { MESSAGE_TYPES } from "@/types/messages";

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
}));

vi.mock("@hooks/useMessageHandler", () => ({
  sendMessage: sendMessageMock,
}));

function createSettings(
  mobileBarLayout: TerminalMobileBarLayout,
  mobileCustomShortcuts: TerminalShortcut[] = []
): FullGlobalSettings {
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      terminal: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.terminal,
        mobileBarLayout,
        mobileCustomShortcuts,
      },
    },
    sources: {},
    isMultiRoot: false,
  };
}

function renderBar(layout: TerminalMobileBarLayout) {
  useSettingsStore.getState().setFullGlobalSettings(createSettings(layout));
  return render(
    <TerminalControlBar workflowId="workflow-1" sessionId="session-1" />
  );
}

describe("TerminalControlBar", () => {
  beforeEach(() => {
    cleanup();
    useSettingsStore.getState().resetSettings();
    sendMessageMock.mockReset();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the configured bar order and keeps Ctrl chord capture at that position", async () => {
    const user = userEvent.setup();
    renderBar({
      bar: [
        TERMINAL_BAR_KEY_IDS.ENTER,
        TERMINAL_BAR_CTRL_ID,
        TERMINAL_BAR_KEY_IDS.ESC,
        TERMINAL_BAR_KEY_IDS.TAB,
        TERMINAL_BAR_KEY_IDS.UP,
        TERMINAL_BAR_KEY_IDS.DOWN,
        TERMINAL_BAR_KEY_IDS.LEFT,
        TERMINAL_BAR_KEY_IDS.RIGHT,
      ],
      popup: [...DEFAULT_TERMINAL_BAR_LAYOUT.popup],
      hidden: [],
    });

    const barButtons = screen
      .getAllByRole("button")
      .map((button) => button.textContent?.trim());
    expect(barButtons.slice(0, 8)).toEqual([
      "⏎",
      "Ctrl",
      "Esc",
      "Tab",
      "↑",
      "↓",
      "←",
      "→",
    ]);

    const ctrlButton = screen.getByRole("button", { name: "Ctrl" });
    await user.click(ctrlButton);
    expect(ctrlButton).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(document, { key: "c" });

    expect(sendMessageMock).toHaveBeenCalledWith(MESSAGE_TYPES.TERMINAL_INPUT, {
      workflowId: "workflow-1",
      sessionId: "session-1",
      data: "\x03",
    });
    expect(ctrlButton).toHaveAttribute("aria-pressed", "false");
  });

  it("hides the More button when the resolved popup is empty", () => {
    renderBar({
      bar: [...DEFAULT_TERMINAL_BAR_LAYOUT.bar],
      popup: ["unknown-popup-id"],
      hidden: [...DEFAULT_TERMINAL_BAR_LAYOUT.popup],
    });

    expect(
      screen.queryByRole("button", { name: "More shortcuts" })
    ).not.toBeInTheDocument();
  });

  it("skips unknown ids in the bar and popup without crashing", () => {
    renderBar({
      bar: ["unknown-bar-id", ...DEFAULT_TERMINAL_BAR_LAYOUT.bar],
      popup: ["unknown-popup-id"],
      hidden: [...DEFAULT_TERMINAL_BAR_LAYOUT.popup],
    });

    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "unknown-bar-id" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "More shortcuts" })
    ).not.toBeInTheDocument();
  });

  it("renders custom popup items in the configured popup order", async () => {
    const user = userEvent.setup();
    const customId = "custom-terminal-shortcut";
    const layout = {
      bar: [...DEFAULT_TERMINAL_BAR_LAYOUT.bar],
      popup: [customId, TERMINAL_BAR_SHORTCUT_IDS.CTRL_C],
      hidden: [
        TERMINAL_BAR_SHORTCUT_IDS.SHIFT_TAB,
        TERMINAL_BAR_SHORTCUT_IDS.CTRL_Z,
        TERMINAL_BAR_SHORTCUT_IDS.CTRL_L,
        TERMINAL_BAR_SHORTCUT_IDS.CTRL_R,
        TERMINAL_BAR_SHORTCUT_IDS.CTRL_A,
      ],
    };
    useSettingsStore
      .getState()
      .setFullGlobalSettings(
        createSettings(layout, [
          { id: customId, label: "Custom", sequence: "\\x1b[1~" },
        ])
      );
    render(
      <TerminalControlBar workflowId="workflow-1" sessionId="session-1" />
    );

    await user.click(screen.getByRole("button", { name: "More shortcuts" }));
    const popupItems = screen
      .getByRole("menu")
      .querySelectorAll('[role="menuitem"]');
    expect(
      Array.from(popupItems).map((item) => item.textContent?.trim())
    ).toEqual(["Custom", "Ctrl+C"]);
  });
});
