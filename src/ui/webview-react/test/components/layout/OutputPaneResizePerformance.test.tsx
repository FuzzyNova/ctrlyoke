import { useCallback, useMemo } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useElementTier } from "@hooks/useElementNarrow";
import { useOutputRowsModel } from "@hooks/useOutputRowsModel";
import {
  bucketOutputContentWidth,
  OUTPUT_CONTENT_WIDTH_BUCKET,
} from "@utils/outputLineMetrics";
import {
  DIFF_VIEW_TYPES,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  OPERATION_STATUS,
  OUTPUT_HISTORY_KINDS,
  OUTPUT_ROW_KINDS,
  CLI_EVENT_TYPES,
} from "@root/types/DashboardConstants";
import { buildOutputRows } from "@utils/outputRows";
import type { OrderedHistoryEntry } from "@root/types/OutputHistoryTypes";

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

function OutputWidthBuildProbe({
  deferWhile = false,
}: {
  deferWhile?: boolean;
}) {
  const [contentRef, contentWidthBucket] = useElementTier(
    bucketOutputContentWidth,
    0,
    deferWhile
  );
  const paneRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        contentRef(null);
        return;
      }
      Object.defineProperty(node, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ width: testState.currentWidth }),
      });
      contentRef(node);
    },
    [contentRef]
  );
  const outputContentWidth = contentWidthBucket * OUTPUT_CONTENT_WIDTH_BUCKET;

  useMemo(() => {
    buildOutputRows(buildInput(outputContentWidth));
  }, [outputContentWidth]);

  return <div ref={paneRef} />;
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

  it("defers a burst of bucket crossings until the pane settles", () => {
    const rendered = render(<OutputWidthBuildProbe />);
    expect(testState.buildCalls).toBe(2);

    rendered.rerender(<OutputWidthBuildProbe deferWhile />);
    for (const width of [1001, 1056, 1120, 1184, 1248]) {
      testState.currentWidth = width;
      act(() => testState.resizeObserverCallback?.());
    }
    expect(testState.buildCalls).toBe(2);

    rendered.rerender(<OutputWidthBuildProbe />);
    expect(testState.buildCalls).toBe(3);
    expect(testState.currentWidth).toBe(1248);
  });

  it("builds rows once for a single load at a stable width", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const cliOutput = {
      prompt: "retry me",
      response: "done",
      elapsed: 1,
      isStreaming: false,
    };
    const liveOrderedEntries: OrderedHistoryEntry[] = [
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        timestampMs: 1,
        sequence: 0,
        target,
        runIndex: 0,
        attemptIndex: 0,
        cliOutput,
      },
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        timestampMs: 2,
        sequence: 1,
        target,
        runIndex: 0,
        attemptIndex: 1,
        cliOutput,
      },
    ];

    renderHook(() =>
      useOutputRowsModel({
        isViewingHistory: false,
        historyOutputs: null,
        liveOrderedEntries,
        liveActivityEntries: [],
        steps: [{ name: "Step", prompt: "" }],
        finalStep: null,
        effectiveHarness: HARNESS_IDS.COPILOT_CLI,
        streamingChunks: {},
        finalStepStreamingChunks: {},
        isExecutionActive: false,
        allowUndoActions: false,
        workspaceSnapshots: {},
        finalStepWorkspaceSnapshots: {},
        undoRecords: {},
        diffsCollapsed: false,
        diffResetVersion: 0,
        outputDiffViewType: DIFF_VIEW_TYPES.UNIFIED,
        outputFontSize: 14,
        outputContentWidth: 768,
        collapsedToolOutputLineCount: 200,
        wordWrap: true,
        invalidateMeasuredRow: vi.fn(),
        invalidateMeasuredRowForUserResize: vi.fn(),
        onDiffViewReset: vi.fn(),
      })
    );

    expect(testState.buildCalls).toBe(1);
  });

  it("builds diff rows once and keeps global collapse toggles working", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const liveOrderedEntries: OrderedHistoryEntry[] = [
      {
        kind: OUTPUT_HISTORY_KINDS.CLI,
        timestampMs: 1,
        sequence: 0,
        target,
        runIndex: 0,
        attemptIndex: 0,
        cliOutput: {
          elapsed: 1,
          isStreaming: false,
          structured: {
            events: [
              {
                type: CLI_EVENT_TYPES.FILE_EDIT,
                data: {
                  path: "src/example.ts",
                  status: OPERATION_STATUS.COMPLETED,
                  structuredPatch: [
                    {
                      oldStart: 1,
                      oldLines: 1,
                      newStart: 1,
                      newLines: 1,
                      lines: ["-const value = 1;", "+const value = 2;"],
                    },
                  ],
                },
              },
            ],
            metadata: {},
          },
        },
      },
    ];
    const baseInput = {
      isViewingHistory: false,
      historyOutputs: null,
      liveOrderedEntries,
      liveActivityEntries: [],
      steps: [{ name: "Edit", prompt: "" }],
      finalStep: null,
      effectiveHarness: HARNESS_IDS.COPILOT_CLI,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: false,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      outputDiffViewType: DIFF_VIEW_TYPES.UNIFIED,
      outputFontSize: 14,
      outputContentWidth: 768,
      collapsedToolOutputLineCount: 200,
      wordWrap: true,
      invalidateMeasuredRow: vi.fn(),
      invalidateMeasuredRowForUserResize: vi.fn(),
      onDiffViewReset: vi.fn(),
    };

    const result = renderHook(
      ({ diffsCollapsed, diffResetVersion }) =>
        useOutputRowsModel({
          ...baseInput,
          diffsCollapsed,
          diffResetVersion,
        }),
      { initialProps: { diffsCollapsed: false, diffResetVersion: 0 } }
    );

    const getDiffRow = () => {
      const row = result.result.current.rows.find(
        (candidate) =>
          candidate.rowKind === OUTPUT_ROW_KINDS.STRUCTURED_EVENT &&
          candidate.diff !== undefined
      );
      if (
        !row ||
        row.rowKind !== OUTPUT_ROW_KINDS.STRUCTURED_EVENT ||
        !row.diff
      ) {
        throw new Error("Expected a structured diff row");
      }
      return { ...row, diff: row.diff };
    };

    expect(testState.buildCalls).toBe(1);
    expect(getDiffRow().diff.isCollapsed).toBe(false);

    act(() => {
      result.rerender({ diffsCollapsed: true, diffResetVersion: 1 });
    });
    expect(getDiffRow().diff.isCollapsed).toBe(true);

    act(() => {
      result.rerender({ diffsCollapsed: false, diffResetVersion: 2 });
    });
    expect(getDiffRow().diff.isCollapsed).toBe(false);

    const diffRow = getDiffRow();
    act(() => {
      result.result.current.handleDiffCollapsedChange(
        diffRow.key,
        diffRow.diff.key,
        true
      );
    });
    expect(getDiffRow().diff.isCollapsed).toBe(true);

    act(() => {
      result.rerender({ diffsCollapsed: false, diffResetVersion: 3 });
    });
    expect(getDiffRow().diff.isCollapsed).toBe(false);
  });
});
