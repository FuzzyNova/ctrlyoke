import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkflowSwitchOverlay } from "@components/layout/WorkflowSwitchOverlay";
import { useUiStore } from "@store/uiStore";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

describe("WorkflowSwitchOverlay", () => {
  beforeEach(() => {
    useUiStore.getState().resetUi();
    useUiStore.setState({
      // resetUi() deliberately leaves displayedViewAddress/appliedViewAddress
      // alone (other suites rely on that). Reset them here too, or a leftover
      // address from a previous test can make requestRunViewLoad see the next
      // test's target as "same lineage" and skip setting pendingRunViewSwitch.
      displayedViewAddress: null,
      appliedViewAddress: null,
      pendingRunViewRequestId: null,
      pendingRunViewAddress: null,
      pendingRunViewSwitch: null,
      runViewLoadRetrying: false,
    });
  });

  it("renders nothing while no cross-lineage switch is pending", () => {
    const { container } = render(<WorkflowSwitchOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the switch target while its snapshot loads, then unmounts on apply", () => {
    render(<WorkflowSwitchOverlay />);

    act(() => {
      useUiStore.getState().requestRunViewLoad(
        {
          workflowKey: "wf-target" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
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

  it("renders nothing for a same-lineage load, which refines panels in place", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-a" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
    });
    const { container } = render(<WorkflowSwitchOverlay />);

    act(() => {
      useUiStore.getState().requestRunViewLoad(
        {
          workflowKey: "wf-a" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: "run-2026-01-01T00-00-00-000Z" as never,
        },
        []
      );
    });

    expect(useUiStore.getState().pendingRunViewRequestId).not.toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  // The overlay swallows pointer events, so it must never own the "how long may
  // this stay up" decision — useRunViewLoadWatchdog does. All this component
  // owes the retry path is an honest label.
  it("says so once the watchdog has had to reissue the request", () => {
    render(<WorkflowSwitchOverlay />);

    act(() => {
      useUiStore.getState().requestRunViewLoad(
        {
          workflowKey: "wf-lost" as never,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
        [],
        undefined,
        "Target workflow"
      );
    });
    expect(
      screen.getByLabelText('Loading "Target workflow"…')
    ).toBeInTheDocument();

    act(() => {
      useUiStore.getState().markRunViewLoadRetrying();
    });

    expect(
      screen.getByLabelText("Still loading workflow…")
    ).toBeInTheDocument();
  });
});
