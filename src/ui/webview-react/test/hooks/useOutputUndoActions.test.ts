import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOutputUndoActions } from "@hooks/useOutputUndoActions";
import { useUiStore } from "@store/uiStore";
import type { RunRef, WorkflowKey } from "@root/types/CtrlYokeTypes";
import {
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import type { OutputRowPromptUndoMeta } from "@utils/outputRows";

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

  it("stamps the displayed run address onto workflow dialog state", async () => {
    const { result } = renderUndoActions();

    await act(async () => {
      result.current.handleWorkflowView();
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
      result.current.handleWorkflowView();
    });

    expect(result.current.workflowDialogState).toBeNull();
  });

  it("keeps blocked candidates in the single workflow entry list", async () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
    const { result } = renderHook(() =>
      useOutputUndoActions({
        allMessages: [
          {
            type: "cli",
            target,
            timestamp: 1,
            data: { isStreaming: false },
          } as never,
        ],
        allowUndoActions: true,
        finalStepWorkspaceSnapshots: {},
        historyOutputs: null,
        isViewingHistory: false,
        lastCliIndexPerStep: new Map([["queue:0", 0]]),
        stepOutputsMap: new Map([["queue:0", []]]),
        undoRecords: {},
        uniqueStepTargets: [target],
        workspaceSnapshots: {
          0: {
            capturedAt: 1,
            strategy: "filesystem",
            changedFiles: [{ path: "src/blocked.ts", changeType: "modified" }],
          },
        },
      })
    );

    await act(async () => result.current.handleWorkflowView());

    expect(result.current.workflowChangeSummary).toMatchObject({
      total: 1,
      undoable: 0,
      undone: 0,
      blocked: 1,
      label: "View 1 change",
    });
    expect(result.current.workflowDialogState?.entries).toHaveLength(1);
    expect(
      result.current.workflowDialogState?.entries[0]?.undoCandidates?.[0]
        ?.instruction
    ).toBeNull();
  });

  it("fetches indexed snapshot restore content before opening a prompt dialog", async () => {
    const postMessage = vi.mocked(window.vscodeApi!.postMessage);
    postMessage.mockClear();
    const { result } = renderUndoActions();
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
    const promptUndo: OutputRowPromptUndoMeta = {
      workspacePath: "/repo",
      allStepOutputs: [],
      workspaceSnapshot: {
        capturedAt: 1,
        strategy: "filesystem",
        changedFiles: [
          {
            path: "src/deleted.ts",
            changeType: "deleted",
            contentAvailableOnDemand: true,
          },
        ],
      },
      summary: {
        total: 1,
        undoable: 0,
        undone: 0,
        blocked: 1,
        label: "View 1 change",
        compactLabel: "View 1",
        title: "1 file changed",
      },
    };

    const opening = result.current.handlePromptViewMeta(target, promptUndo);
    const request = postMessage.mock.calls[0]?.[0] as
      { type: string; requestId: string } | undefined;
    expect(request?.type).toBe(
      MESSAGE_TYPES.REQUEST_WORKSPACE_SNAPSHOT_CONTENT
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT,
            requestId: request?.requestId,
            beforeContent: "before",
            contentToRestore: "original deleted file",
          },
        })
      );
    });
    await act(async () => opening);

    expect(
      result.current.minimapDialogState?.input?.snapshotOnlyFiles[0]
    ).toMatchObject({
      contentToRestore: "original deleted file",
    });
    expect(
      result.current.minimapDialogState?.input?.snapshotOnlyFiles[0]
    ).toMatchObject({ changeType: "deleted" });
  });
});
