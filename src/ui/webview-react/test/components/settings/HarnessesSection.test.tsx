import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessesSection } from "@components/settings/HarnessesSection";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES, SETTING_SCOPES } from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function settings(): FullGlobalSettings {
  return {
    settings: CTRLYOKE_SETTINGS_DEFAULTS,
    sources: {},
    isMultiRoot: false,
  };
}

describe("HarnessesSection defaults", () => {
  beforeEach(() => {
    vi.mocked(getVsCodeApi().postMessage).mockClear();
  });

  it("renders no usage data and sends no usage messages", () => {
    render(
      <HarnessesSection
        settings={settings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => undefined}
        onReset={() => undefined}
      />
    );

    expect(screen.queryByText(/Usage:/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Refresh harness usage" })
    ).not.toBeInTheDocument();

    const postMessage = vi.mocked(getVsCodeApi().postMessage);
    expect(postMessage).not.toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REQUEST_HARNESS_USAGE,
    });
    expect(postMessage).not.toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REFRESH_HARNESS_USAGE,
    });
  });
});
