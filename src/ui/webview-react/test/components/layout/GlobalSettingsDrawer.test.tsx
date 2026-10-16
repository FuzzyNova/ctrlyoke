import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSettingsDrawer } from "@components/layout/GlobalSettingsDrawer";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { searchSettingsCatalog } from "@components/settings/settingsSearch";
import { ALL_TABS } from "@components/settings/settingsTabs";
import {
  GLOBAL_SETTINGS_TABS,
  HARNESS_IDS,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";

const fullSettings: FullGlobalSettings = {
  settings: CTRLYOKE_SETTINGS_DEFAULTS,
  sources: {},
  isMultiRoot: false,
};

describe("GlobalSettingsDrawer", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      fullGlobalSettings: fullSettings,
      globalSettingsReadOnly: false,
    });
    useUiStore.setState({
      globalSettingsOpen: true,
      globalSettingsActiveTab: "statusline",
    });
  });

  it("renders the shared User and Workspace scope options beside settings tabs", () => {
    render(<GlobalSettingsDrawer />);

    expect(
      screen.getByRole("button", { name: "Stats & Usage" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Status Line" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "User" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Workspace" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.getByText("Statusline Tracking")).toBeInTheDocument();
  });

  it("draws the Templates tab with the From template Lucide glyph", () => {
    render(<GlobalSettingsDrawer />);

    const tab = screen.getByRole("button", { name: "Templates" });
    expect(tab.querySelector("svg.lucide-notepad-text-dashed")).not.toBeNull();
    expect(tab.querySelector(".codicon")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "General" })
        .querySelector(".codicon-settings")
    ).not.toBeNull();
  });

  it("lets the MCP Manager use the full settings content width", () => {
    useUiStore.setState({ globalSettingsActiveTab: "mcpmanager" });

    render(<GlobalSettingsDrawer />);

    const content = screen
      .getByText("MCP Manager", { selector: "h3" })
      .closest("div.p-4");

    expect(content).toHaveClass("max-w-none");
    expect(content).not.toHaveClass("max-w-2xl");
  });

  it("disables settings controls when the settings file uses a newer format", () => {
    useSettingsStore.setState({ globalSettingsReadOnly: true });

    render(<GlobalSettingsDrawer />);

    expect(document.querySelector("fieldset")).toBeDisabled();
    expect(
      screen.getByText(
        "These settings use a newer format. Update ctrlyoke to edit them."
      )
    ).toBeInTheDocument();
  });

  it("saves only the User model pricing map when editing the User scope", () => {
    const postMessage = vi.mocked(window.vscodeApi!.postMessage);
    postMessage.mockClear();
    useSettingsStore.setState({
      fullGlobalSettings: {
        ...fullSettings,
        settings: {
          ...fullSettings.settings,
          modelPricing: {
            [HARNESS_IDS.CLAUDE_CLI]: {
              "workspace-only": { inputPerMTok: 90, outputPerMTok: 100 },
            },
          },
        },
        modelPricingByScope: {
          user: {
            [HARNESS_IDS.CLAUDE_CLI]: {
              "user-model": { inputPerMTok: 1, outputPerMTok: 2 },
            },
          },
          workspace: {
            [HARNESS_IDS.CLAUDE_CLI]: {
              "workspace-only": { inputPerMTok: 90, outputPerMTok: 100 },
            },
          },
        },
      },
    });
    useUiStore.setState({ globalSettingsActiveTab: GLOBAL_SETTINGS_TABS.STATS });

    render(<GlobalSettingsDrawer />);
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Input rate for user-model" }),
      { target: { value: "12" } }
    );
    fireEvent.blur(
      screen.getByRole("spinbutton", { name: "Input rate for user-model" })
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path: "modelPricing",
      value: {
        [HARNESS_IDS.CLAUDE_CLI]: {
          "user-model": { inputPerMTok: 12, outputPerMTok: 2 },
        },
      },
      scope: "user",
    });
  });

  it("opens and closes search, clears its query, and shows match badges", () => {
    render(<GlobalSettingsDrawer />);
    const toggle = screen.getByRole("button", { name: "Search settings" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
      target: { value: "max steps" },
    });

    expect(
      screen.getByRole("button", { name: "Queue, 2 matches" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "License, 0 matches" })
    ).toHaveClass("opacity-40");
    expect(screen.getByText("1/2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(
      screen.queryByRole("textbox", { name: "Search settings" })
    ).toBeNull();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(
      screen.getByRole("textbox", { name: "Search settings" })
    ).toHaveValue("");
  });

  it("reopens with search closed and empty after the drawer closes", () => {
    render(<GlobalSettingsDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Search settings" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
      target: { value: "queue" },
    });
    act(() => useUiStore.setState({ globalSettingsOpen: false }));
    act(() => useUiStore.setState({ globalSettingsOpen: true }));

    expect(
      screen.queryByRole("textbox", { name: "Search settings" })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Search settings" })
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("routes Ctrl+F to settings search and closes it before closing the drawer", () => {
    render(<GlobalSettingsDrawer />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = screen.getByRole("textbox", { name: "Search settings" });
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.queryByRole("textbox", { name: "Search settings" })
    ).toBeNull();
    expect(useUiStore.getState().globalSettingsOpen).toBe(true);

    fireEvent.keyDown(screen.getByRole("button", { name: "Search settings" }), {
      key: "Escape",
    });
    expect(useUiStore.getState().globalSettingsOpen).toBe(false);
  });

  it("closes the Set secret dialog without closing the settings drawer", () => {
    useUiStore.setState({ globalSettingsActiveTab: "secrets" });
    render(<GlobalSettingsDrawer />);

    fireEvent.click(screen.getByRole("button", { name: "Set secret" }));
    expect(
      screen.getByRole("dialog", { name: "Set secret" })
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Set secret" })).toBeNull();
    expect(useUiStore.getState().globalSettingsOpen).toBe(true);
  });

  it("moves a search match to its Workflow Defaults tab and sub-page", () => {
    render(<GlobalSettingsDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Search settings" }));
    const input = screen.getByRole("textbox", { name: "Search settings" });
    fireEvent.change(input, {
      target: { value: "defaults.toolPermissions.mode" },
    });

    expect(
      screen.getByRole("button", { name: "Workflow Defaults, 1 matches" })
    ).toHaveClass("bg-list-active-bg");
    expect(screen.getByRole("tab", { name: /Permissions/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("keeps search navigation on a tab with matches and wraps backward", () => {
    useUiStore.setState({ globalSettingsActiveTab: "queue" });
    render(<GlobalSettingsDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Search settings" }));
    const input = screen.getByRole("textbox", { name: "Search settings" });
    fireEvent.change(input, { target: { value: "max steps" } });
    expect(
      screen.getByRole("button", { name: "Queue, 2 matches" })
    ).toHaveClass("bg-list-active-bg");

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("2/2")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "zzqxxx nohitword" } });
    expect(
      screen.getByText("No settings match “zzqxxx nohitword”")
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "license activation" } });
    expect(
      screen.getByRole("button", { name: "License, 1 matches" })
    ).toHaveClass("bg-list-active-bg");
  });

  it("advances from the last match on one tab to the next tab with matches", () => {
    useUiStore.setState({
      globalSettingsActiveTab: GLOBAL_SETTINGS_TABS.QUEUE,
    });
    render(<GlobalSettingsDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Search settings" }));
    const input = screen.getByRole("textbox", { name: "Search settings" });
    fireEvent.change(input, { target: { value: "max" } });

    const matches = searchSettingsCatalog("max", { devEnabled: false }).matches;
    const queueMatches = matches.filter(
      (entry) => entry.tab === GLOBAL_SETTINGS_TABS.QUEUE
    );
    const lastQueueIndex = matches.findIndex(
      (entry) => entry.id === queueMatches[queueMatches.length - 1]?.id
    );
    const expectedNextTab = matches[(lastQueueIndex + 1) % matches.length].tab;

    for (let i = 0; i < queueMatches.length; i += 1) {
      fireEvent.keyDown(input, { key: "Enter" });
    }

    expect(useUiStore.getState().globalSettingsActiveTab).toBe(expectedNextTab);
    const expectedLabel = ALL_TABS.find(
      (tab) => tab.id === expectedNextTab
    )?.label;
    expect(
      screen.getByRole("button", { name: new RegExp(`^${expectedLabel},`) })
    ).toHaveClass("bg-list-active-bg");
  });
});
