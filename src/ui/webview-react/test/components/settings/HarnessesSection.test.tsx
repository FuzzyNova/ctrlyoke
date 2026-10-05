import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessesSection } from "@components/settings/HarnessesSection";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import {
  AUTO_DETECT_HARNESS,
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  MESSAGE_TYPES,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import { useSettingsStore } from "@store/settingsStore";
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
    useSettingsStore.getState().resetSettings();
  });

  it("defaults to auto-detect, naming the first installed harness alphabetically", async () => {
    const available = {
      available: true,
      status: HARNESS_STATUS_STRINGS.AVAILABLE,
    };
    useSettingsStore
      .getState()
      .setHarnessStatus(HARNESS_IDS.COPILOT_CLI, available);
    useSettingsStore
      .getState()
      .setHarnessStatus(HARNESS_IDS.CODEX_CLI, available);
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(
      <HarnessesSection
        settings={settings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={() => undefined}
      />
    );

    const trigger = screen.getByRole("button", {
      name: /Choose active harness/,
    });
    expect(trigger).toHaveTextContent("Auto-detect (Codex)");

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: /^Claude Code/ }));
    expect(onUpdate).toHaveBeenLastCalledWith(
      "defaults.harness",
      HARNESS_IDS.CLAUDE_CLI
    );

    await user.click(trigger);
    await user.click(
      screen.getByRole("button", { name: /^Auto-detect \(Codex\)/ })
    );
    expect(onUpdate).toHaveBeenLastCalledWith(
      "defaults.harness",
      AUTO_DETECT_HARNESS
    );
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

  it("commits additional args on blur, not on every keystroke", async () => {
    if (!Range.prototype.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const { container } = render(
      <HarnessesSection
        settings={settings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={() => undefined}
      />
    );
    const content = container.querySelector<HTMLElement>(
      "#extra-args-claude-cli"
    );
    if (!content) throw new Error("Claude additional args editor not rendered");

    await user.click(content);
    fireEvent.paste(content, {
      clipboardData: { getData: () => "--effort" },
    });
    expect(onUpdate).not.toHaveBeenCalled();

    fireEvent.blur(content);
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledWith(
      "defaults.additionalArgs.claude-cli",
      "--effort"
    );
  });
});
