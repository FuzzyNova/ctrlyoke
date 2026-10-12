import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralSection } from "@components/settings/GeneralSection";
import {
  EDITOR_FONT_SIZE_VSCODE,
  STEP_COLOR_MODES,
  type EditorFontSize,
} from "@root/types/DashboardConstants";
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
  it("leaves the default-template setting to the Templates tab", () => {
    renderGeneralSection(STEP_COLOR_MODES.UNIQUE);
    expect(
      screen.queryByLabelText(/general.defaultTemplate/)
    ).not.toBeInTheDocument();
  });

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

describe("GeneralSection font sizes", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--vscode-editor-font-size");
  });

  function renderWithFonts(
    editorFontSize: EditorFontSize,
    outputFontSize = 13
  ) {
    const onUpdate = vi.fn();
    const current = settings(STEP_COLOR_MODES.NONE);
    current.settings.ui.editorFontSize = editorFontSize;
    current.settings.ui.outputFontSize = outputFontSize;
    render(
      <GeneralSection
        settings={current}
        activeScope="user"
        onUpdate={onUpdate}
        onReset={() => undefined}
        onReload={() => undefined}
      />
    );
    return onUpdate;
  }

  it("steps the output font size setting and stops at its bounds", () => {
    const onUpdate = renderWithFonts(EDITOR_FONT_SIZE_VSCODE, 24);

    expect(
      screen.getByRole("button", { name: "Increase output font size" })
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Decrease output font size" })
    );
    expect(onUpdate).toHaveBeenCalledWith("ui.outputFontSize", 23);
  });

  it("follows VS Code by default with no editor size stepper", () => {
    renderWithFonts(EDITOR_FONT_SIZE_VSCODE);

    expect(
      screen.getByRole("button", {
        name: /^Match VS Code, property ui\.editorFontSize/,
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Increase editor font size" })
    ).not.toBeInTheDocument();
  });

  it("starts Custom from the editor size currently on screen", () => {
    document.documentElement.style.setProperty(
      "--vscode-editor-font-size",
      "16px"
    );
    const onUpdate = renderWithFonts(EDITOR_FONT_SIZE_VSCODE);

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Match VS Code, property ui\.editorFontSize/,
      })
    );
    const customOptions = screen.getAllByRole("button", {
      name: /^Custom.*ui\.editorFontSize/,
    });
    fireEvent.click(customOptions[customOptions.length - 1]);

    expect(onUpdate).toHaveBeenCalledWith("ui.editorFontSize", 16);
  });

  it("steps a custom editor size and can return to VS Code", () => {
    const onUpdate = renderWithFonts(18);

    fireEvent.click(
      screen.getByRole("button", { name: "Increase editor font size" })
    );
    expect(onUpdate).toHaveBeenCalledWith("ui.editorFontSize", 19);

    fireEvent.click(
      screen.getByRole("button", {
        name: /^Custom, property ui\.editorFontSize/,
      })
    );
    const vscodeOptions = screen.getAllByRole("button", {
      name: /^Match VS Code.*ui\.editorFontSize/,
    });
    fireEvent.click(vscodeOptions[vscodeOptions.length - 1]);

    expect(onUpdate).toHaveBeenLastCalledWith(
      "ui.editorFontSize",
      EDITOR_FONT_SIZE_VSCODE
    );
  });
});
