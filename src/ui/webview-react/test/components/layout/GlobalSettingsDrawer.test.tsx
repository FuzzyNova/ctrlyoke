import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { GlobalSettingsDrawer } from "@components/layout/GlobalSettingsDrawer";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";

const fullSettings: FullGlobalSettings = {
  settings: CTRLYOKE_SETTINGS_DEFAULTS,
  sources: {},
  isMultiRoot: false,
};

describe("GlobalSettingsDrawer", () => {
  beforeEach(() => {
    useSettingsStore.setState({ fullGlobalSettings: fullSettings });
    useUiStore.setState({
      globalSettingsOpen: true,
      globalSettingsActiveTab: "statusline",
    });
  });

  it("includes the Status Line tab beside the stats tab", () => {
    render(<GlobalSettingsDrawer />);

    expect(
      screen.getByRole("button", { name: "Stats & Usage" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Status Line" })
    ).toBeInTheDocument();
    expect(screen.getByText("Statusline Tracking")).toBeInTheDocument();
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

  it("shows the Pro unlock button only for Free users", () => {
    useSettingsStore.setState({
      licenseAccess: {
        isPro: false,
        hasRemoteAccess: false,
        trialEndsAt: null,
      },
    });
    const { unmount } = render(<GlobalSettingsDrawer />);
    expect(
      screen.getByRole("button", { name: "Unlock Pro Features" })
    ).toBeInTheDocument();
    unmount();

    useSettingsStore.setState({
      licenseAccess: { isPro: true, hasRemoteAccess: true, trialEndsAt: null },
    });
    render(<GlobalSettingsDrawer />);
    expect(
      screen.queryByRole("button", { name: "Unlock Pro Features" })
    ).not.toBeInTheDocument();
  });
});
