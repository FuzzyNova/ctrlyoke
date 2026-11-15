import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DefaultsValidationPage } from "@components/settings/defaults/DefaultsValidationPage";
import { SETTING_SCOPES } from "@/types/messages";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

describe("DefaultsValidationPage reset buttons", () => {
  it("resets the default error behavior setting", () => {
    const onReset = vi.fn();
    const settings: FullGlobalSettings = {
      settings: CTRLYOKE_SETTINGS_DEFAULTS,
      sources: { "defaults.errorBehavior": SETTING_SCOPES.USER },
      isMultiRoot: false,
    };

    render(
      <DefaultsValidationPage
        settings={settings}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => undefined}
        onReset={onReset}
      />
    );

    const reset = screen.getByRole("button", {
      name: "Reset Default Error Behavior",
    });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledWith("defaults.errorBehavior");
  });
});
