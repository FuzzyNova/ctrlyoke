import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DefaultsHarnessPage } from "@components/settings/defaults/DefaultsHarnessPage";
import { SETTING_SCOPES } from "@/types/messages";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { WORKTREE_MODES } from "@root/types/DashboardConstants";

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

    expect(onUpdate).toHaveBeenCalledWith("defaults.executionMode", "headless");
  });

  it("renders progressive Named worktree defaults with scoped paths", () => {
    const onUpdate = vi.fn();
    const settings = createSettings();
    settings.settings.defaults.worktree = {
      mode: WORKTREE_MODES.NAMED,
      branch: "settings-branch",
      base: "main",
      setup: "npm ci",
    };

    render(
      <DefaultsHarnessPage
        settings={settings}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={() => {}}
      />
    );

    expect(screen.getByText("Worktree Defaults")).toBeInTheDocument();
    expect(screen.getByLabelText("Branch")).toHaveValue("settings-branch");
    expect(screen.getByLabelText("Base")).toHaveValue("main");
    expect(screen.getByLabelText("Setup")).toHaveValue("npm ci");
  });

  it("renders progressive Managed worktree defaults with keep, merge, and the live-checkout warning", () => {
    const onUpdate = vi.fn();
    const settings = createSettings();
    settings.settings.defaults.worktree = {
      mode: WORKTREE_MODES.MANAGED,
      base: "main",
      setup: "npm ci",
      keep: true,
      merge: true,
    };

    render(
      <DefaultsHarnessPage
        settings={settings}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={() => {}}
      />
    );

    expect(screen.getByLabelText("Base")).toHaveValue("main");
    expect(screen.getByLabelText("Setup")).toHaveValue("npm ci");
    expect(screen.getByLabelText("Keep directory")).toBeChecked();
    expect(screen.getByLabelText("Merge")).toBeChecked();
    expect(
      screen.getByText(/merges the managed branch into the working checkout after every run/i)
    ).toBeInTheDocument();

    screen.getByLabelText("Keep directory").click();
    expect(onUpdate).toHaveBeenCalledWith("defaults.worktree.keep", false);

    screen.getByLabelText("Merge").click();
    expect(onUpdate).toHaveBeenCalledWith("defaults.worktree.merge", false);
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
