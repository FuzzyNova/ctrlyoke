import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LicenseSection } from "@components/settings/LicenseSection";
import {
  LICENSE_ACTIONS,
  LICENSE_UI,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import { LICENSE_SOURCES } from "../../../../../license/LicenseService";
import { useSettingsStore } from "@store/settingsStore";

const postMessage = vi.fn();

describe("LicenseSection", () => {
  beforeEach(() => {
    postMessage.mockReset();
    useSettingsStore.setState({
      licenseAccess: {
        isPro: false,
        hasRemoteAccess: false,
        trialEndsAt: null,
      },
      licenseMachines: [],
      licenseSeatUsage: null,
      licenseActionResult: null,
    });
    window.vscodeApi = {
      postMessage,
      getState: () => undefined,
      setState: () => undefined,
    };
  });

  afterEach(() => {
    useSettingsStore.setState({
      licenseMachines: [],
      licenseActionResult: null,
    });
  });

  it("activates with a key and displays the client-scoped result", async () => {
    render(<LicenseSection />);

    const input = screen.getByLabelText("Pro license key");
    fireEvent.change(input, { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.ACTIVATE_LICENSE_KEY,
      key: "test-key",
    });

    useSettingsStore.getState().setLicenseActionResult({
      action: MESSAGE_TYPES.ACTIVATE_LICENSE_KEY,
      status: "success",
      message: "License activated successfully.",
    });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "License activated successfully."
      )
    );
  });

  it("imports an offline license blob", () => {
    render(<LicenseSection />);
    const blob =
      "-----BEGIN LICENSE FILE-----\nsigned\n-----END LICENSE FILE-----";

    fireEvent.change(
      screen.getByRole("textbox", { name: "Offline license file" }),
      {
        target: { value: blob },
      }
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Import license file" })
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.IMPORT_LICENSE_FILE,
      blob,
    });
  });

  it("shows machine-limit recovery and protects the current machine row", async () => {
    render(<LicenseSection />);
    useSettingsStore.getState().setLicenseActionResult({
      action: LICENSE_ACTIONS.ACTIVATION_LIMIT,
      status: "error",
      message: "Machine limit reached",
    });

    await waitFor(() =>
      expect(
        screen.getByText(/Free up a slot, then retry activation/)
      ).toBeInTheDocument()
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REQUEST_LICENSE_MACHINES,
    });

    useSettingsStore.getState().setLicenseMachines([
      {
        id: "mine",
        name: "Laptop",
        platform: "win32",
        createdAt: "2026-08-01T00:00:00.000Z",
        isThisMachine: true,
      },
      {
        id: "other",
        name: "Desktop",
        platform: "linux",
        createdAt: "2026-08-02T00:00:00.000Z",
        isThisMachine: false,
      },
    ]);
    useSettingsStore.getState().setLicenseActionResult({
      action: MESSAGE_TYPES.REQUEST_LICENSE_MACHINES,
      status: "success",
      message: "License machines loaded.",
    });

    await waitFor(() =>
      expect(screen.getByText("Laptop · win32")).toBeInTheDocument()
    );
    expect(screen.getByText("This machine")).toBeInTheDocument();
    const deactivateButtons = screen.getAllByRole("button", {
      name: "Deactivate",
    });
    expect(deactivateButtons[0]).toBeDisabled();
    expect(deactivateButtons[1]).toBeEnabled();

    fireEvent.click(deactivateButtons[1]);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.DEACTIVATE_LICENSE_MACHINE,
      machineId: "other",
    });
  });

  it("confirms before deactivating the current Pro machine", () => {
    useSettingsStore.setState({
      licenseAccess: {
        isPro: true,
        hasRemoteAccess: true,
        trialEndsAt: null,
        source: LICENSE_SOURCES.ONLINE,
        expiresAt: null,
      },
    });
    render(<LicenseSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Deactivate Pro License" })
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Deactivate the Pro license on this machine?"
    );
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.DEACTIVATE_LICENSE })
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Deactivate" }));
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.DEACTIVATE_LICENSE,
    });
  });

  it("shows that the remote-access trial is available before first use", () => {
    useSettingsStore.setState({
      licenseAccess: {
        isPro: false,
        hasRemoteAccess: true,
        trialEndsAt: null,
        source: null,
        expiresAt: null,
      },
    });
    render(<LicenseSection />);

    expect(
      screen.getByText(LICENSE_UI.REMOTE_ACCESS_TRIAL_AVAILABLE)
    ).toBeInTheDocument();
  });

  it("hides self-service machine management for Enterprise and points to support", () => {
    useSettingsStore.setState({
      licenseAccess: {
        isPro: true,
        hasRemoteAccess: true,
        trialEndsAt: null,
        source: LICENSE_SOURCES.ONLINE,
        expiresAt: null,
        isEnterprise: true,
      },
    });
    render(<LicenseSection />);

    const status = screen.getByRole("region", { name: "License status" });
    expect(within(status).getAllByText("Enterprise")).toHaveLength(2);
    expect(within(status).queryByText("Pro")).not.toBeInTheDocument();

    expect(
      screen.queryByRole("heading", { name: "Activated machines" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.REQUEST_LICENSE_MACHINES,
      })
    );
    expect(
      screen.getByRole("link", { name: LICENSE_UI.SUPPORT_EMAIL })
    ).toHaveAttribute("href", `mailto:${LICENSE_UI.SUPPORT_EMAIL}`);
  });

  it("shows Enterprise seat usage once the extension replies", async () => {
    useSettingsStore.setState({
      licenseAccess: {
        isPro: true,
        hasRemoteAccess: true,
        trialEndsAt: null,
        source: LICENSE_SOURCES.ONLINE,
        expiresAt: null,
        isEnterprise: true,
      },
    });
    render(<LicenseSection />);

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REQUEST_LICENSE_SEAT_USAGE,
    });
    expect(screen.getByText("Loading seats…")).toBeInTheDocument();

    useSettingsStore.setState({
      licenseSeatUsage: { used: 1234, max: 3000 },
      licenseActionResult: {
        action: MESSAGE_TYPES.REQUEST_LICENSE_SEAT_USAGE,
        status: "success",
        message: "License seat usage loaded.",
      },
    });

    const seats = screen.getByRole("region", { name: "Enterprise seats" });
    await waitFor(() =>
      expect(
        within(seats).getByText(/1,234 of 3,000 seats in use/)
      ).toBeInTheDocument()
    );
    expect(within(seats).getByText(/1,766 remaining/)).toBeInTheDocument();
    expect(within(seats).getByRole("meter")).toHaveAttribute(
      "aria-valuenow",
      "1234"
    );
  });

  it("skips the seat lookup for an offline Enterprise license file", () => {
    useSettingsStore.setState({
      licenseAccess: {
        isPro: true,
        hasRemoteAccess: true,
        trialEndsAt: null,
        source: LICENSE_SOURCES.OFFLINE_FILE,
        expiresAt: null,
        isEnterprise: true,
      },
    });
    render(<LicenseSection />);

    expect(postMessage).not.toHaveBeenCalledWith({
      type: MESSAGE_TYPES.REQUEST_LICENSE_SEAT_USAGE,
    });
    expect(
      screen.queryByRole("button", { name: "Refresh" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: LICENSE_UI.SUPPORT_EMAIL })
    ).toBeInTheDocument();
  });
});
