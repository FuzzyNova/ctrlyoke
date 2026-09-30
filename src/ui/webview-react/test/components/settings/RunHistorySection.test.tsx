import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunHistorySection } from "@components/settings/RunHistorySection";
import {
  RUN_HISTORY_LOCATIONS,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function createSettings(): FullGlobalSettings {
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      storage: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.storage,
        runHistoryLocation: RUN_HISTORY_LOCATIONS.USER,
      },
    },
    sources: {},
    runHistoryPath: "C:/Users/test/.ctrlyoke/projects/ctrlyoke-hash/.runs",
    isMultiRoot: false,
  };
}

const props = () => ({
  settings: createSettings(),
  activeScope: SETTING_SCOPES.USER,
  onUpdate: vi.fn(),
  onReset: vi.fn(),
  onReload: vi.fn(),
});

describe("RunHistorySection", () => {
  it("renders the user-scoped control and resolved location", () => {
    render(<RunHistorySection {...props()} />);

    expect(
      screen.getByRole("button", {
        name: "Run history location, property storage.runHistoryLocation",
      })
    ).not.toBeDisabled();
    expect(screen.getByText("Requires reload")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "C:/Users/test/.ctrlyoke/projects/ctrlyoke-hash/.runs"
    );
  });

  it("disables the control at workspace scope", () => {
    render(
      <RunHistorySection {...props()} activeScope={SETTING_SCOPES.WORKSPACE} />
    );

    expect(
      screen.getByRole("button", {
        name: "Run history location, property storage.runHistoryLocation",
      })
    ).toBeDisabled();
    expect(
      screen.getByText(/user-scoped and cannot be changed/i)
    ).toBeInTheDocument();
  });

  it("writes the user value and presents the reload/no-migration warning", () => {
    const sectionProps = props();
    render(<RunHistorySection {...sectionProps} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Run history location, property storage.runHistoryLocation",
      })
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Workspace, storage.runHistoryLocation: workspace",
      })
    );

    expect(sectionProps.onUpdate).toHaveBeenCalledWith(
      "storage.runHistoryLocation",
      RUN_HISTORY_LOCATIONS.WORKSPACE
    );
    expect(
      screen.getByText(/does not migrate data.*different history/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reload window" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload window" }));
    expect(sectionProps.onReload).toHaveBeenCalledOnce();
  });
});
