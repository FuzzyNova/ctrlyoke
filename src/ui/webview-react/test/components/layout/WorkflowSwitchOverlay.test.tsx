import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowSwitchOverlay } from "@components/layout/WorkflowSwitchOverlay";
import { useUiStore } from "@store/uiStore";

describe("WorkflowSwitchOverlay", () => {
  beforeEach(() => {
    useUiStore.getState().resetUi();
    useUiStore.setState({
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

  it("clears the whole pending request if the snapshot never arrives", () => {
    vi.useFakeTimers();
    render(<WorkflowSwitchOverlay />);

    act(() => {
      useUiStore
        .getState()
        .requestRunViewLoad(
          { workflowKey: "wf-lost" as never, kind: "draft" },
          []
        );
    });
    expect(useUiStore.getState().pendingRunViewSwitch).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    // Both halves must clear: a stuck pending id would keep suppressing later
    // requestless snapshots long after the overlay problem is visible.
    expect(useUiStore.getState().pendingRunViewSwitch).toBeNull();
    expect(useUiStore.getState().pendingRunViewRequestId).toBeNull();
  });
});
