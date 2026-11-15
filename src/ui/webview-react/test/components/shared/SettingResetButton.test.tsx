import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  INHERIT_DEFAULT_OPTION,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import {
  canResetSetting,
  hasSettingSourceBadge,
  SettingResetButton,
} from "@components/shared/SettingResetButton";

describe("SettingResetButton", () => {
  it("renders an enabled button for the active scope and applies extra classes", () => {
    const onReset = vi.fn();
    render(
      <SettingResetButton
        label="Port"
        path="server.port"
        source={SETTING_SCOPES.USER}
        activeScope={SETTING_SCOPES.USER}
        onReset={onReset}
        className="shrink-0 mt-0.5"
      />
    );

    const button = screen.getByRole("button", { name: "Reset Port" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("title", "Reset to default");
    expect(button).toHaveClass("shrink-0", "mt-0.5");
    fireEvent.click(button);
    expect(onReset).toHaveBeenCalledWith("server.port");
  });

  it("shares the reset and badge visibility guards for unavailable sources", () => {
    expect(canResetSetting(SETTING_SCOPES.WORKSPACE, SETTING_SCOPES.USER)).toBe(
      false
    );
    expect(canResetSetting(INHERIT_DEFAULT_OPTION, SETTING_SCOPES.USER)).toBe(
      false
    );
    expect(canResetSetting(undefined, SETTING_SCOPES.USER)).toBe(false);
    expect(hasSettingSourceBadge(INHERIT_DEFAULT_OPTION)).toBe(false);
    expect(hasSettingSourceBadge(undefined)).toBe(false);
  });

  it("uses the source in the disabled title", () => {
    render(
      <SettingResetButton
        label="Port"
        path="server.port"
        source={SETTING_SCOPES.WORKSPACE}
        activeScope={SETTING_SCOPES.USER}
        onReset={() => undefined}
      />
    );

    const button = screen.getByRole("button", { name: "Reset Port" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Defined in workspace config");
  });
});
