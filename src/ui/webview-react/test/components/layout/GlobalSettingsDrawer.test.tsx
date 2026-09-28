import { act, fireEvent, render, screen } from "@testing-library/react";
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
    useSettingsStore.setState({
      fullGlobalSettings: fullSettings,
      globalSettingsReadOnly: false,
    });
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
});
