import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdvancedSection } from "@components/settings/AdvancedSection";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function settings(): FullGlobalSettings {
  return {
    settings: structuredClone(CTRLYOKE_SETTINGS_DEFAULTS),
    sources: {},
    isMultiRoot: false,
  };
}

function renderAdvanced(current = settings(), onUpdate = vi.fn()) {
  render(
    <AdvancedSection
      settings={current}
      activeScope="user"
      onUpdate={onUpdate}
      onReset={() => undefined}
      onReload={() => undefined}
    />
  );
  return onUpdate;
}

describe("AdvancedSection", () => {
  it("groups runs, run history, prompt files, MCP, coordination and diagnostics", () => {
    renderAdvanced();

    for (const heading of [
      "Runs",
      "Run History",
      "Prompt Files",
      "ctrlyoke MCP server",
      "Coordination",
      "Diagnostics",
    ]) {
      expect(
        screen.getByRole("heading", { name: heading }),
        heading
      ).toBeInTheDocument();
    }
  });

  it("uses Unlimited for max runs without showing the stored -1", () => {
    const current = settings();
    current.settings.runs.maxRuns = -1;
    renderAdvanced(current);

    expect(
      screen.getByRole("button", {
        name: "Unlimited, property runs.maxRuns",
      })
    ).toBeInTheDocument();
  });

  it("disables raw CLI logging until diagnostic logs are on", () => {
    const onUpdate = renderAdvanced();

    const raw = screen.getByRole("checkbox", { name: /Log raw CLI output/ });
    expect(raw).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", { name: /Enable diagnostic logs/ })
    );
    expect(onUpdate).toHaveBeenCalledWith("diagnostics.verboseLogging", true);
  });
});
