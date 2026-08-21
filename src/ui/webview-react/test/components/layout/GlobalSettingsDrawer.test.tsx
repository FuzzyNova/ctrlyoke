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
});
