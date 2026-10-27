import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsSection } from "@components/settings/NotificationsSection";
import { useUiStore } from "@store/uiStore";
import { SETTING_SCOPES } from "@/types/messages";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import {
  HOOK_EVENT_METADATA,
  HOOK_EVENT_NAMES,
} from "@root/types/DashboardConstants";

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
      ({ event }) => event === HOOK_EVENT_NAMES.NOTIFICATION
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
    expect(screen.getByText(/raw per-harness events/)).toBeInTheDocument();

    await user.click(notificationToggle);

    expect(onUpdate).toHaveBeenCalledWith(
      "notifications.events.hookEvents.notification",
      true
    );
  });

  it("offers the default-on Waiting for input toggle", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    render(
      <NotificationsSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={() => {}}
      />
    );

    const toggle = screen.getByLabelText(
      "Waiting for input, property notifications.events.awaitingInput"
    ) as HTMLInputElement;
    expect(toggle).toBeChecked();
    expect(
      screen.getByText(
        "Notify when Copilot CLI, Claude Code, Codex CLI, OpenCode, or Qwen Code is waiting for your input. Antigravity is not supported."
      )
    ).toBeInTheDocument();
    await user.click(toggle);

    expect(onUpdate).toHaveBeenCalledWith(
      "notifications.events.awaitingInput",
      false
    );
  });

  it("updates the toast notification severity threshold", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    render(
      <NotificationsSection
        settings={createSettings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={() => {}}
      />
    );

    expect(screen.getByText("Toast notifications")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Controls in-app and native popups for action results.*separate from the completion notifications configured above/i
      )
    ).toBeInTheDocument();

    const toastLevelSelect = document.getElementById("notif-toast-level");
    expect(toastLevelSelect).not.toBeNull();
    await user.click(toastLevelSelect!);
    await user.click(
      screen.getByRole("button", {
        name: "Warning and Error, notifications.toastLevel: warningAndError",
      })
    );

    expect(onUpdate).toHaveBeenCalledWith(
      "notifications.toastLevel",
      "warningAndError"
    );
  });
});
