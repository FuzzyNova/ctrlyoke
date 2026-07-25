import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowSwitchOverlay } from "@components/layout/WorkflowSwitchOverlay";
import { useUiStore } from "@store/uiStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";

describe("WorkflowSwitchOverlay", () => {
  beforeEach(() => {
    (getVsCodeApi().postMessage as ReturnType<typeof vi.fn>).mockClear();
    useUiStore.getState().resetUi();
    useUiStore.setState({
      // resetUi() deliberately leaves displayedViewAddress/appliedViewAddress
      // alone (other suites rely on that). Reset them here too, or a leftover
      // address from a previous test can make requestRunViewLoad see the next
      // test's target as "same lineage" and skip setting pendingRunViewSwitch.
      displayedViewAddress: null,
      appliedViewAddress: null,
      pendingRunViewRequestId: null,
      pendingRunViewSwitch: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing while no cross-lineage switch is pending", () => {
    const { container } = render(<WorkflowSwitchOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the switch target while its snapshot loads, then unmounts on apply", () => {
    render(<WorkflowSwitchOverlay />);

    act(() => {
      useUiStore
        .getState()
        .requestRunViewLoad(
          { workflowKey: "wf-target" as never, kind: "draft" },
          [],
          undefined,
          "Target workflow"
        );
    });
    expect(
      screen.getByLabelText('Loading "Target workflow"…')
    ).toBeInTheDocument();

    act(() => {
      useUiStore.getState().clearPendingRunViewLoad();
    });
    expect(screen.queryByLabelText('Loading "Target workflow"…')).toBeNull();
  });

  it("does not clear or time out a response arriving between 10s and 30s", () => {
    vi.useFakeTimers();
    render(<WorkflowSwitchOverlay />);

    act(() => {
      useUiStore
        .getState()
        .requestRunViewLoad(
          { workflowKey: "wf-slow" as never, kind: "draft" },
          []
        );
    });

    act(() => {
      vi.advanceTimersByTime(25000);
    });
    // Still pending — the old 10-second cutoff would have already cleared it.
    expect(useUiStore.getState().pendingRunViewSwitch).not.toBeNull();
    expect(getVsCodeApi().postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.LOAD_RUN_VIEW })
    );

    act(() => {
      useUiStore.getState().clearPendingRunViewLoad();
    });
    expect(useUiStore.getState().pendingRunViewSwitch).toBeNull();
  });

  it("retries the same request instead of clearing it if the snapshot never arrives by 30s", () => {
    vi.useFakeTimers();
    render(<WorkflowSwitchOverlay />);

    const address = { workflowKey: "wf-lost" as never, kind: "draft" as const };
    let requestId = "";
    act(() => {
      requestId = useUiStore.getState().requestRunViewLoad(address, []);
    });
    expect(useUiStore.getState().pendingRunViewSwitch).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    // The pending request must survive the timeout — clearing it here would
    // leave the client addressed to a workflow whose content was never
    // applied, with no way to recover short of the user noticing and
    // re-clicking (which the old displayedViewAddress-only no-op suppressed).
    expect(useUiStore.getState().pendingRunViewSwitch).not.toBeNull();
    expect(useUiStore.getState().pendingRunViewRequestId).toBe(requestId);
    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.LOAD_RUN_VIEW,
        address,
        requestId,
      })
    );
  });

  it("updates the label after the retry fires", () => {
    vi.useFakeTimers();
    render(<WorkflowSwitchOverlay />);

    act(() => {
      useUiStore
        .getState()
        .requestRunViewLoad(
          { workflowKey: "wf-lost" as never, kind: "draft" },
          [],
          undefined,
          "Target workflow"
        );
    });
    expect(
      screen.getByLabelText('Loading "Target workflow"…')
    ).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(screen.getByLabelText("Still loading workflow…")).toBeInTheDocument();
  });
});
