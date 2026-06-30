import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { NotificationsSection } from "@components/settings/NotificationsSection";
import { useUiStore } from "@store/uiStore";
import { SETTING_SCOPES } from "@/types/messages";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function createSettings(): FullGlobalSettings {
  return {
    settings: CTRLYOKE_SETTINGS_DEFAULTS,
    sources: {},
  };
}

describe("NotificationsSection", () => {
  beforeEach(() => {
    useUiStore.getState().setGlobalSettingsTab("notifications");
  });

  it("links phone notification HTTPS guidance to Server settings", async () => {
    const user = userEvent.setup();

    render(
      <NotificationsSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={() => {}}
        onReset={() => {}}
      />
    );

    expect(screen.getByText(/including on your phone/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Server settings" }));

    expect(useUiStore.getState().globalSettingsActiveTab).toBe("server");
  });
});
