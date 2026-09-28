import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GeneralSection } from "@components/settings/GeneralSection";
import { STEP_COLOR_MODES } from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function settings(stepColorMode: string): FullGlobalSettings {
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      ui: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.ui,
        stepColorMode:
          stepColorMode as (typeof STEP_COLOR_MODES)[keyof typeof STEP_COLOR_MODES],
      },
    },
    sources: {},
    isMultiRoot: false,
  };
}

function renderGeneralSection(stepColorMode: string) {
  return render(
    <GeneralSection
      settings={settings(stepColorMode)}
      activeScope="user"
      onUpdate={() => undefined}
      onReset={() => undefined}
      onReload={() => undefined}
    />
  );
}

describe("GeneralSection script step color control", () => {
  it("shows the script step color control only in harness mode", () => {
    renderGeneralSection(STEP_COLOR_MODES.HARNESS);

    expect(
      screen.getByLabelText(
        "Script step color, property ui.harnessColors.script"
      )
    ).toBeInTheDocument();
  });

  it("hides the script step color control when step colors are off", () => {
    renderGeneralSection(STEP_COLOR_MODES.NONE);

    expect(
      screen.queryByLabelText(
        "Script step color, property ui.harnessColors.script"
      )
    ).not.toBeInTheDocument();
  });

  it("hides the script step color control in unique mode", () => {
    renderGeneralSection(STEP_COLOR_MODES.UNIQUE);

    expect(
      screen.queryByLabelText(
        "Script step color, property ui.harnessColors.script"
      )
    ).not.toBeInTheDocument();
  });
});

describe("GeneralSection limit controls", () => {
  it("uses Never for the output virtualization threshold", () => {
    renderGeneralSection(STEP_COLOR_MODES.UNIQUE);

    expect(
      screen.getByRole("button", {
        name: "Custom, property ui.outputVirtualizationRowThreshold",
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", {
        name: "Output virtualization row threshold Custom, property ui.outputVirtualizationRowThreshold",
      })
    ).toHaveAttribute("min", "0");
  });

  it("uses Unlimited for max runs without showing the stored -1", () => {
    const current = settings(STEP_COLOR_MODES.UNIQUE);
    current.settings.runs.maxRuns = -1;
    render(
      <GeneralSection
        settings={current}
        activeScope="user"
        onUpdate={() => undefined}
        onReset={() => undefined}
        onReload={() => undefined}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "Unlimited, property runs.maxRuns",
      })
    ).toBeInTheDocument();
  });
});
