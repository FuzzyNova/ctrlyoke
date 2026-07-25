import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DefaultsHarnessPage } from "@components/settings/defaults/DefaultsHarnessPage";
import { SETTING_SCOPES } from "@/types/messages";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function createSettings(
  sources: Record<string, "user" | "workspace" | "default"> = {}
): FullGlobalSettings {
  return {
    settings: CTRLYOKE_SETTINGS_DEFAULTS,
    sources,
    isMultiRoot: false,
  };
}

describe("DefaultsHarnessPage execution defaults", () => {
  it("renders the execution mode row and writes the new setting path", async () => {
    const onUpdate = vi.fn();
    const user = userEvent.setup();

    render(
      <DefaultsHarnessPage
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={() => {}}
      />
    );

    expect(screen.getByText("Execution Defaults")).toBeInTheDocument();
    expect(
      screen.getByText(/Pre\/end-condition scripts always run headless/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Execution mode" }));
    await user.click(screen.getByRole("button", { name: "Headless" }));

    expect(onUpdate).toHaveBeenCalledWith(
      "defaults.executionMode",
      "headless"
    );
  });

  it("shows the active-scope reset affordance", async () => {
    const onReset = vi.fn();
    const user = userEvent.setup();

    render(
      <DefaultsHarnessPage
        settings={createSettings({ "defaults.executionMode": "workspace" })}
        activeScope={SETTING_SCOPES.WORKSPACE}
        onUpdate={() => {}}
        onReset={onReset}
      />
    );

    const resetButton = screen.getByRole("button", {
      name: "Reset Execution mode",
    });
    expect(resetButton).toBeEnabled();

    await user.click(resetButton);

    expect(onReset).toHaveBeenCalledWith("defaults.executionMode");
  });
});
