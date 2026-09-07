import { useMemo } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useElementTier } from "@hooks/useElementNarrow";
import {
  bucketOutputContentWidth,
  OUTPUT_CONTENT_WIDTH_BUCKET,
} from "@utils/outputLineMetrics";
import { DIFF_VIEW_TYPES } from "@root/types/DashboardConstants";
import { buildOutputRows } from "@utils/outputRows";

const testState = vi.hoisted(() => ({
  buildCalls: 0,
  currentWidth: 1000,
  resizeObserverCallback: null as (() => void) | null,
}));

vi.mock("@utils/createAnimationFrameResizeObserver", () => ({
  createAnimationFrameResizeObserver: (callback: () => void) => {
    testState.resizeObserverCallback = callback;
    return {
      observer: { observe: vi.fn() },
      disconnect: vi.fn(),
    };
  },
}));

vi.mock("@utils/outputRows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@utils/outputRows")>();
  return {
    ...actual,
    buildOutputRows: (input: Parameters<typeof actual.buildOutputRows>[0]) => {
      testState.buildCalls++;
      return actual.buildOutputRows(input);
    },
  };
});

function buildInput(
  outputContentWidth: number
): Parameters<typeof buildOutputRows>[0] {
  return {
    allMessages: [],
    steps: [],
    finalStep: null,
    streamingChunks: {},
    finalStepStreamingChunks: {},
    isExecutionActive: false,
    allowUndoActions: false,
    isViewingHistory: false,
    historyOutputs: null,
    workspaceSnapshots: {},
    finalStepWorkspaceSnapshots: {},
    undoRecords: {},
    diffCollapseState: new Map(),
    diffExpansionState: new Map(),
    toolCallExpansionState: new Map(),
    defaultDiffCollapsed: false,
    diffViewType: DIFF_VIEW_TYPES.UNIFIED,
    outputContentWidth,
  };
}

function OutputWidthBuildProbe() {
  const [contentRef, contentWidthBucket] = useElementTier(
    bucketOutputContentWidth,
    0
  );
  const outputContentWidth = contentWidthBucket * OUTPUT_CONTENT_WIDTH_BUCKET;

  useMemo(() => {
    buildOutputRows(buildInput(outputContentWidth));
  }, [outputContentWidth]);

  return (
    <div
      ref={(node) => {
        if (!node) {
          contentRef(null);
          return;
        }
        Object.defineProperty(node, "getBoundingClientRect", {
          configurable: true,
          value: () => ({ width: testState.currentWidth }),
        });
        contentRef(node);
      }}
    />
  );
}

describe("output pane width bucketing", () => {
  beforeEach(() => {
    testState.buildCalls = 0;
    testState.currentWidth = 1000;
    testState.resizeObserverCallback = null;
  });

  it("builds rows at most once per 32px bucket during a resize gesture", () => {
    render(<OutputWidthBuildProbe />);
    // The initial unmeasured build at width 0 is followed by the first
    // callback-ref measurement. The gesture assertions begin after that mount
    // work has settled.
    expect(testState.buildCalls).toBe(2);

    for (const width of [1001, 1015, 1023]) {
      testState.currentWidth = width;
      act(() => testState.resizeObserverCallback?.());
    }
    expect(testState.buildCalls).toBe(2);

    testState.currentWidth = 1024;
    act(() => testState.resizeObserverCallback?.());
    expect(testState.buildCalls).toBe(3);

    testState.currentWidth = 1055;
    act(() => testState.resizeObserverCallback?.());
    expect(testState.buildCalls).toBe(3);

    testState.currentWidth = 1056;
    act(() => testState.resizeObserverCallback?.());
    expect(testState.buildCalls).toBe(4);
  });
});
