import { describe, it, expect, vi, beforeEach } from "vitest";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  isDrillableRunNav,
  runNavIndicatorLabel,
  viewedRunLabel,
  navigateToWorkflowAddress,
} from "@utils/runNavigation";
import { MESSAGE_TYPES } from "@/types/messages";
import type { RunSummary } from "@root/types/WorkflowTimelineTypes";

const WORKFLOW_KEY = "wf-1" as never;

function summary(runId: number, runRef: string): RunSummary {
  return {
    workflowKey: WORKFLOW_KEY,
    runRef: runRef as never,
    runId,
    startedAt: runId * 1000,
    executionState: "completed" as never,
    definitionRevision: 1,
    stepCount: 1,
    hasMixedHarnesses: false,
    hasMixedModels: false,
  };
}

describe("isDrillableRunNav", () => {
  it("is false when undefined", () => {
    expect(isDrillableRunNav(undefined)).toBe(false);
  });

  it("is false for a single run with no draft", () => {
    expect(
      isDrillableRunNav({
        primaryAddress: {
          workflowKey: WORKFLOW_KEY,
          kind: "run",
          runRef: "r1" as never,
        },
        primaryRunId: 1,
        runCount: 1,
        hasDraft: false,
      })
    ).toBe(false);
  });

  it("is false for a draft-only lineage", () => {
    expect(
      isDrillableRunNav({
        primaryAddress: { workflowKey: WORKFLOW_KEY, kind: "draft" },
        runCount: 0,
        hasDraft: true,
      })
    ).toBe(false);
  });

  it("is true for multiple runs", () => {
    expect(
      isDrillableRunNav({
        primaryAddress: {
          workflowKey: WORKFLOW_KEY,
          kind: "run",
          runRef: "r2" as never,
        },
        primaryRunId: 2,
        runCount: 2,
        hasDraft: false,
      })
    ).toBe(true);
  });

  it("is true for one run plus a draft", () => {
    expect(
      isDrillableRunNav({
        primaryAddress: { workflowKey: WORKFLOW_KEY, kind: "draft" },
        runCount: 1,
        hasDraft: true,
      })
    ).toBe(true);
  });
});

describe("runNavIndicatorLabel", () => {
  const baseRunNav = {
    primaryAddress: {
      workflowKey: WORKFLOW_KEY,
      kind: "run" as const,
      runRef: "r12" as never,
    },
    primaryRunId: 12,
    runCount: 2,
    hasDraft: false,
  };

  it("renders Run <id> for a run primary address", () => {
    expect(runNavIndicatorLabel(baseRunNav, false)).toBe("Run 12");
  });

  it("renders #<id> in narrow mode", () => {
    expect(runNavIndicatorLabel(baseRunNav, true)).toBe("#12");
  });

  it("renders Draft for a draft primary address regardless of narrow mode", () => {
    const draftRunNav = {
      primaryAddress: { workflowKey: WORKFLOW_KEY, kind: "draft" as const },
      runCount: 1,
      hasDraft: true,
    };
    expect(runNavIndicatorLabel(draftRunNav, false)).toBe("Draft");
    expect(runNavIndicatorLabel(draftRunNav, true)).toBe("Draft");
  });
});

describe("viewedRunLabel", () => {
  const runSummaries = [summary(2, "run-2"), summary(1, "run-1")];

  it("resolves the viewed run's manifest runId by matching runRef, not array position", () => {
    // Deliberately out of array order relative to runId to prove it's not index-derived.
    const address = {
      workflowKey: WORKFLOW_KEY,
      kind: "run" as const,
      runRef: "run-1" as never,
    };
    expect(viewedRunLabel(address, runSummaries, false)).toBe("Run 1");
  });

  it("renders Draft for a draft address", () => {
    const address = { workflowKey: WORKFLOW_KEY, kind: "draft" as const };
    expect(viewedRunLabel(address, runSummaries, false)).toBe("Draft");
  });

  it("renders the narrow #<id> form", () => {
    const address = {
      workflowKey: WORKFLOW_KEY,
      kind: "run" as const,
      runRef: "run-2" as never,
    };
    expect(viewedRunLabel(address, runSummaries, true)).toBe("#2");
  });
});

describe("navigateToWorkflowAddress", () => {
  const postMessage = vi.fn();
  const vscode = { postMessage };

  beforeEach(() => {
    postMessage.mockClear();
    useUiStore.getState().resetUi();
    useUiStore.setState({
      displayedViewAddress: null,
      runSummaries: [],
      executionRunRef: null,
      pendingRunViewSwitch: null,
      pendingRunViewRequestId: null,
    });
    useWorkflowStore.getState().resetWorkflow();
  });

  it("no-ops when the address is already displayed", () => {
    const address = {
      workflowKey: WORKFLOW_KEY,
      kind: "run" as const,
      runRef: "run-1" as never,
    };
    useUiStore.setState({ displayedViewAddress: address });

    navigateToWorkflowAddress(vscode, address);

    expect(postMessage).not.toHaveBeenCalled();
  });

  it("sends LOAD_RUN_VIEW for an ordinary address switch", () => {
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: WORKFLOW_KEY,
        kind: "run",
        runRef: "run-1" as never,
      },
    });
    const target = {
      workflowKey: WORKFLOW_KEY,
      kind: "run" as const,
      runRef: "run-2" as never,
    };

    navigateToWorkflowAddress(vscode, target, "My Workflow");

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.LOAD_RUN_VIEW,
        address: target,
        requestId: expect.any(String),
      })
    );
  });

  it("returns to live output and loads the authoritative view for the currently executing run", () => {
    const executingAddress = {
      workflowKey: WORKFLOW_KEY,
      kind: "run" as const,
      runRef: "run-executing" as never,
    };
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: WORKFLOW_KEY,
        kind: "run",
        runRef: "run-old" as never,
      },
      executionRunRef: "run-executing" as never,
      isViewingHistory: true,
    });

    navigateToWorkflowAddress(vscode, executingAddress);

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.LOAD_RUN_VIEW,
        address: executingAddress,
        requestId: expect.any(String),
      })
    );
    expect(useUiStore.getState().displayedViewAddress).toEqual(
      executingAddress
    );
    expect(useUiStore.getState().isViewingHistory).toBe(false);
  });
});
