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
      screen.getByRole("button", {
        name: "Choose server bind address, property server.bindAddress",
      })
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

  it("warns when the generated cert doesn't cover the LAN address phones connect to", () => {
    const props = {
      activeScope: SETTING_SCOPES.USER,
      onUpdate: vi.fn(),
      onReset: vi.fn(),
    };
    const withTls = (bindAddress: string): FullGlobalSettings => {
      const settings = createSettings(bindAddress);
      return {
        ...settings,
        settings: {
          ...settings.settings,
          server: {
            ...settings.settings.server,
            tls: { ...settings.settings.server.tls, enabled: true },
          },
        },
      };
    };
    useSettingsStore.setState({
      licenseAccess: { isPro: true, hasRemoteAccess: true, trialEndsAt: null },
      bindAddressFallback: null,
      availableIps: ["192.168.55.25"],
      lastCertGenerated: {
        generatedAt: "2026-10-06T00:00:00.000Z",
        expiresAt: "2099-10-06T00:00:00.000Z",
        sans: ["localhost", "127.0.0.1"],
      },
    });
    const { rerender } = render(
      <ServerSection {...props} settings={withTls("0.0.0.0")} />
    );

    expect(
      screen.getByText(/doesn't cover 192\.168\.55\.25/)
    ).toBeInTheDocument();

    rerender(<ServerSection {...props} settings={withTls("127.0.0.1")} />);
    expect(screen.queryByText(/doesn't cover/)).not.toBeInTheDocument();

    useSettingsStore.setState({ lastCertGenerated: null });
  });

  it("defaults Connect via to the public hostname and offers the LAN address too", () => {
    const settings = createSettings("0.0.0.0");
    settings.settings.server = {
      ...settings.settings.server,
      publicHostname: "my-pc.example.ts.net",
    };
    useSettingsStore.setState({
      licenseAccess: { isPro: true, hasRemoteAccess: true, trialEndsAt: null },
      bindAddressFallback: null,
      serverUrl: "http://192.168.55.25:4747/?token=test",
      availableIps: ["192.168.55.25"],
    });
    render(
      <ServerSection
        settings={settings}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(
      screen.getByRole("link", {
        name: "http://my-pc.example.ts.net:4747/?token=test",
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose server connection address" })
    ).toHaveTextContent("my-pc.example.ts.net (public hostname)");
  });

  it("ignores a stored public hostname and disables the field without remote access", () => {
    const settings = createSettings("0.0.0.0");
    settings.settings.server = {
      ...settings.settings.server,
      publicHostname: "my-pc.example.ts.net",
    };
    useSettingsStore.setState({
      licenseAccess: {
        isPro: false,
        hasRemoteAccess: false,
        trialEndsAt: null,
      },
      bindAddressFallback: null,
      serverUrl: "http://192.168.55.25:4747/?token=test",
      availableIps: ["192.168.55.25"],
    });
    render(
      <ServerSection
        settings={settings}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(
      screen.getByRole("link", {
        name: "http://192.168.55.25:4747/?token=test",
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /my-pc\.example\.ts\.net/ })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Public hostname/)).toBeDisabled();
  });

  it("saves a normalized public hostname and rejects a URL", () => {
    const onUpdate = vi.fn();
    useSettingsStore.setState({
      licenseAccess: { isPro: true, hasRemoteAccess: true, trialEndsAt: null },
      bindAddressFallback: null,
    });
    render(
      <ServerSection
        settings={createSettings("0.0.0.0")}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={vi.fn()}
      />
    );
    const input = screen.getByLabelText(/^Public hostname/);

    fireEvent.change(input, {
      target: { value: "https://my-pc.example.ts.net" },
    });
    fireEvent.blur(input);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByText(/without https:\/\//)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: " My-PC.Example.ts.net " } });
    fireEvent.blur(input);
    expect(onUpdate).toHaveBeenCalledWith(
      "server.publicHostname",
      "my-pc.example.ts.net"
    );
    expect(screen.queryByText(/without https:\/\//)).not.toBeInTheDocument();
  });

  it("hides the public hostname field for a localhost-only server", () => {
    render(
      <ServerSection
        settings={createSettings("127.0.0.1")}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );
    expect(screen.queryByLabelText(/^Public hostname/)).not.toBeInTheDocument();
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

  it("adds and removes fallback ports", () => {
    const onUpdate = vi.fn();
    const props = {
      activeScope: SETTING_SCOPES.USER,
      onUpdate,
      onReset: vi.fn(),
    };
    const settings: FullGlobalSettings = {
      settings: {
        ...CTRLYOKE_SETTINGS_DEFAULTS,
        server: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.server,
          fallbackPorts: [4749],
        },
      },
      sources: {},
      isMultiRoot: false,
    };
    render(<ServerSection {...props} settings={settings} />);

    expect(screen.getByTestId("port-list-entry-4749")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Fallback port"), {
      target: { value: "4750" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onUpdate).toHaveBeenCalledWith("server.fallbackPorts", [4749, 4750]);

    fireEvent.click(screen.getByRole("button", { name: "Remove port 4749" }));
    expect(onUpdate).toHaveBeenCalledWith("server.fallbackPorts", []);
  });

  it("rejects an out-of-range fallback port instead of adding it", () => {
    const onUpdate = vi.fn();
    const props = {
      activeScope: SETTING_SCOPES.USER,
      onUpdate,
      onReset: vi.fn(),
    };
    render(<ServerSection {...props} settings={createSettings("127.0.0.1")} />);

    fireEvent.change(screen.getByLabelText("Fallback port"), {
      target: { value: "99999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(
      screen.getByText("Enter a port number between 1 and 65535.")
    ).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalledWith(
      "server.fallbackPorts",
      expect.anything()
    );
  });

  it("starts the cert install help with the QR code step in the panel", () => {
    const settings = createSettings("0.0.0.0");
    settings.settings.server = {
      ...settings.settings.server,
      tls: { ...settings.settings.server.tls, enabled: true },
    };
    render(
      <ServerSection
        activeScope={SETTING_SCOPES.USER}
        settings={settings}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );

    // One QR step per platform list (iOS and Android).
    expect(
      screen.getAllByRole("img", { name: "the QR code button" })
    ).toHaveLength(2);
  });
});
