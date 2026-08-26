import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useOutputUndoActions } from "@hooks/useOutputUndoActions";
import { useUiStore } from "@store/uiStore";
import type { RunRef, WorkflowKey } from "@root/types/CtrlYokeTypes";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

const RUN_ADDRESS = {
  workflowKey: "workflow-1" as WorkflowKey,
  kind: "run" as const,
  runRef: "run-2026-01-01T00-00-00-000Z" as RunRef,
};

function renderUndoActions() {
  let renderCount = 0;
  const hook = renderHook(() => {
    renderCount += 1;
    return useOutputUndoActions({
      allMessages: [],
      allowUndoActions: true,
      finalStepWorkspaceSnapshots: {},
      historyOutputs: null,
      isViewingHistory: true,
      lastCliIndexPerStep: new Map(),
      stepOutputsMap: new Map(),
      undoRecords: {},
      uniqueStepTargets: [],
      workspaceSnapshots: {},
    });
  });
  return { ...hook, getRenderCount: () => renderCount };
}

describe("useOutputUndoActions", () => {
  beforeEach(() => {
    useUiStore.setState({ displayedViewAddress: RUN_ADDRESS });
  });

  // Regression: deriving the run address inside the zustand selector returned a
  // freshly built object on every snapshot read, so useSyncExternalStore
  // re-rendered forever ("Maximum update depth exceeded") as soon as a run
  // address was displayed.
  it("stays settled while a run address is displayed", () => {
    const { getRenderCount, rerender } = renderUndoActions();
    const rendersAfterMount = getRenderCount();

    act(() => {
      useUiStore.setState({ outputFontSize: 15 });
    });
    rerender();

    expect(getRenderCount() - rendersAfterMount).toBeLessThanOrEqual(2);
  });

  it("stamps the displayed run address onto workflow dialog state", () => {
    const { result } = renderUndoActions();

    act(() => {
      result.current.handleWorkflowUndo();
    });

    expect(result.current.workflowDialogState?.address).toEqual({
      workflowKey: RUN_ADDRESS.workflowKey,
      runRef: RUN_ADDRESS.runRef,
    });
  });

  it("does not open a workflow dialog without a displayed run address", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: RUN_ADDRESS.workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      },
    });
    const { result } = renderUndoActions();

    act(() => {
      result.current.handleWorkflowUndo();
    });

    expect(result.current.workflowDialogState).toBeNull();
  });
});
