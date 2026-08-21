import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusLineSection } from "@components/settings/StatusLineSection";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function createSettings(): FullGlobalSettings {
  return {
    settings: CTRLYOKE_SETTINGS_DEFAULTS,
    sources: {},
    isMultiRoot: false,
  };
}

describe("StatusLineSection", () => {
  it("renders statusline controls for each tracked provider", () => {
    render(<StatusLineSection settings={createSettings()} />);

    expect(screen.getByText("Statusline Tracking")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Configure provider statusline integration to capture token, quota, and context-window metrics."
      )
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("textbox", { name: "Custom statusline command" })
    ).toHaveLength(2);
    expect(
      screen.getByRole("checkbox", {
        name: /^Enable Claude Code statusline tracking/,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: /^Enable Antigravity CLI statusline tracking/,
      })
    ).toBeInTheDocument();
  });
});
