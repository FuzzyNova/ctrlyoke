import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerSection } from "@components/settings/ServerSection";
import { SETTING_SCOPES } from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { useSettingsStore } from "@store/settingsStore";

function createSettings(bindAddress: string): FullGlobalSettings {
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      server: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.server,
        bindAddress,
      },
    },
    sources: {},
    isMultiRoot: false,
  };
}

describe("ServerSection", () => {
  beforeEach(() => {
    window.vscodeApi = {
      postMessage: vi.fn(),
      getState: () => undefined,
      setState: () => undefined,
    };
    useSettingsStore.setState({
      licenseAccess: {
        isPro: false,
        hasRemoteAccess: false,
        trialEndsAt: null,
      },
      serverRunning: true,
      serverUrl: "http://localhost:4747/?token=test",
      availableIps: [],
      selectedDisplayIp: null,
      portFallback: null,
      bindAddressFallback: {
        requestedBindAddress: "0.0.0.0",
        actualBindAddress: "127.0.0.1",
      },
    });
  });

  afterEach(() => {
    useSettingsStore.setState({
      serverRunning: false,
      serverUrl: null,
      availableIps: [],
      selectedDisplayIp: null,
      portFallback: null,
      bindAddressFallback: null,
    });
  });

  it("shows the bind fallback only for the still-configured address and labels the Pro option", () => {
    const props = {
      activeScope: SETTING_SCOPES.USER,
      onUpdate: vi.fn(),
      onReset: vi.fn(),
    };
    const { rerender } = render(
      <ServerSection {...props} settings={createSettings("0.0.0.0")} />
    );

    expect(
      screen.getByText(
        /ctrlyoke started on localhost only.*All Interfaces \(0\.0\.0\.0\)/
      )
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Choose server bind address" })
    );
    expect(
      screen.getByText(
        "Pro feature — unlocks with a Pro license or an active remote-access trial"
      )
    ).toBeInTheDocument();

    rerender(
      <ServerSection {...props} settings={createSettings("127.0.0.1")} />
    );
    expect(
      screen.queryByText(/ctrlyoke started on localhost only/)
    ).not.toBeInTheDocument();
  });

  it("shows the Pro unlock banner only for Free users", () => {
    const props = {
      activeScope: SETTING_SCOPES.USER,
      onUpdate: vi.fn(),
      onReset: vi.fn(),
    };
    const { rerender } = render(
      <ServerSection {...props} settings={createSettings("0.0.0.0")} />
    );

    expect(
      screen.getByRole("button", { name: "Unlock Pro Features" })
    ).toBeInTheDocument();

    useSettingsStore.setState({
      licenseAccess: { isPro: true, hasRemoteAccess: true, trialEndsAt: null },
    });
    rerender(<ServerSection {...props} settings={createSettings("0.0.0.0")} />);

    expect(
      screen.queryByRole("button", { name: "Unlock Pro Features" })
    ).not.toBeInTheDocument();
  });
});
