import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsSection } from "@components/settings/NotificationsSection";
import { useUiStore } from "@store/uiStore";
import { SETTING_SCOPES } from "@/types/messages";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { HOOK_EVENT_METADATA } from "@root/types/DashboardConstants";

function createSettings(): FullGlobalSettings {
  return {
    settings: CTRLYOKE_SETTINGS_DEFAULTS,
    sources: {},
    isMultiRoot: false,
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

  it("offers an unchecked Notification hook-event toggle with shared guidance", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const notificationDescription = HOOK_EVENT_METADATA.find(
      ({ event }) => event === "notification"
    )?.description;

    render(
      <NotificationsSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={() => {}}
      />
    );

    const notificationLabel = screen.getByText("Notification").closest("label");
    expect(notificationLabel).not.toBeNull();
    const notificationToggle = notificationLabel!.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    expect(notificationToggle).not.toBeChecked();
    expect(screen.getByText(notificationDescription!)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Opt in to notifications for AI CLI hook events. Requires the corresponding harness to support each event."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Codex|Antigravity|OpenCode/)
    ).not.toBeInTheDocument();

    await user.click(notificationToggle);

    expect(onUpdate).toHaveBeenCalledWith(
      "notifications.events.hookEvents.notification",
      true
    );
  });
});
