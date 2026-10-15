import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupOverlay } from "@components/layout/StartupOverlay";
import { useUiStore } from "@store/uiStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import {
  DASHBOARD_HOST_CAPABILITIES,
  MESSAGE_TYPES,
  WORKSPACE_FOLDER_PICKERS,
} from "@root/types/DashboardConstants";

const SLOW_HINT = /Still starting up/;

describe("StartupOverlay", () => {
  beforeEach(() => {
    (getVsCodeApi().postMessage as ReturnType<typeof vi.fn>).mockClear();
    useUiStore.getState().resetUi();
    // resetUi() leaves the startup gate fields alone, so reset them explicitly —
    // a leftover workspaceInitRequired suppresses the spinner in the next test.
    useUiStore.setState({
      startupReady: false,
      workspaceFolderRequired: false,
      workspaceInitRequired: false,
      showLayoutPreference: false,
      devRestarting: false,
      hostCapabilities: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks the dashboard until startup completes", () => {
    render(<StartupOverlay />);

    expect(screen.getByLabelText("Loading ctrlyoke…")).toBeInTheDocument();

    act(() => {
      useUiStore.getState().setStartupReady(true);
    });
    expect(screen.queryByLabelText("Loading ctrlyoke…")).toBeNull();
  });

  // The safety timeout is a "the extension host is broken" escape hatch, not a
  // budget for normal startup. A real workspace measured 15.9s from panel READY
  // to STARTUP_COMPLETE, and the previous 8s value dismissed the overlay mid-
  // startup — reopening the interaction window where a workflow the user created
  // or switched to got overwritten by the auto-load arriving seconds later.
  it("stays up through a slow but healthy startup", () => {
    vi.useFakeTimers();
    render(<StartupOverlay />);

    act(() => {
      vi.advanceTimersByTime(20000);
    });

    expect(useUiStore.getState().startupReady).toBe(false);
    expect(screen.getByLabelText("Loading ctrlyoke…")).toBeInTheDocument();
  });

  it("explains the delay rather than showing a bare spinner", () => {
    vi.useFakeTimers();
    render(<StartupOverlay />);

    expect(screen.queryByText(SLOW_HINT)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(12000);
    });

    expect(screen.getByText(SLOW_HINT)).toBeInTheDocument();
  });

  it("dismisses itself if STARTUP_COMPLETE never arrives at all", () => {
    vi.useFakeTimers();
    render(<StartupOverlay />);

    act(() => {
      vi.advanceTimersByTime(45000);
    });

    expect(useUiStore.getState().startupReady).toBe(true);
    expect(screen.queryByLabelText("Loading ctrlyoke…")).toBeNull();
  });

  it("never times out while the workspace-init prompt is waiting on the user", () => {
    vi.useFakeTimers();
    act(() => {
      useUiStore.getState().setWorkspaceInitRequired(true);
    });
    render(<StartupOverlay />);

    act(() => {
      vi.advanceTimersByTime(120000);
    });

    expect(useUiStore.getState().startupReady).toBe(false);
    expect(
      screen.getByLabelText("Initialize ctrlyoke in this workspace")
    ).toBeInTheDocument();
    // The init prompt owns the overlay; the slow-startup hint would contradict it.
    expect(screen.queryByText(SLOW_HINT)).toBeNull();
  });

  describe("with no folder open", () => {
    const OPEN_FOLDER_LABEL = "Open a folder to use ctrlyoke";

    it("asks for a folder instead of loading, and never times out", () => {
      vi.useFakeTimers();
      act(() => {
        useUiStore.getState().setWorkspaceFolderRequired(true);
      });
      render(<StartupOverlay />);

      act(() => {
        vi.advanceTimersByTime(120000);
      });

      expect(useUiStore.getState().startupReady).toBe(false);
      expect(screen.getByLabelText(OPEN_FOLDER_LABEL)).toBeInTheDocument();
      expect(screen.queryByText(SLOW_HINT)).toBeNull();
      expect(screen.queryByText("Initialize ctrlyoke")).toBeNull();
    });

    it("asks the host to open a folder or a recent one", () => {
      act(() => {
        useUiStore.setState({
          workspaceFolderRequired: true,
          hostCapabilities: [DASHBOARD_HOST_CAPABILITIES.pickWorkspaceFolder],
        });
      });
      render(<StartupOverlay />);

      fireEvent.click(screen.getByRole("button", { name: "Open Folder…" }));
      fireEvent.click(screen.getByRole("button", { name: "Open Recent…" }));

      expect(getVsCodeApi().postMessage).toHaveBeenNthCalledWith(1, {
        type: MESSAGE_TYPES.OPEN_WORKSPACE_FOLDER,
        picker: WORKSPACE_FOLDER_PICKERS.BROWSE,
      });
      expect(getVsCodeApi().postMessage).toHaveBeenNthCalledWith(2, {
        type: MESSAGE_TYPES.OPEN_WORKSPACE_FOLDER,
        picker: WORKSPACE_FOLDER_PICKERS.RECENT,
      });
    });

    it("offers no buttons when the host cannot show a folder dialog", () => {
      act(() => {
        useUiStore.getState().setWorkspaceFolderRequired(true);
      });
      render(<StartupOverlay />);

      expect(screen.getByLabelText(OPEN_FOLDER_LABEL)).toBeInTheDocument();
      expect(screen.queryByRole("button")).toBeNull();
    });
  });

  it("shows the reconnect message instead of the slow-startup hint while restarting", () => {
    vi.useFakeTimers();
    act(() => {
      useUiStore.getState().setDevRestarting(true);
      useUiStore.setState({ startupReady: false });
    });
    render(<StartupOverlay />);

    act(() => {
      vi.advanceTimersByTime(12000);
    });

    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
    expect(screen.queryByText(SLOW_HINT)).toBeNull();
  });
});
