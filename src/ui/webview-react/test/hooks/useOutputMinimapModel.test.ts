import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FINAL_STEP_PHASES,
  OUTPUT_ACTIVITY_KINDS,
  OUTPUT_MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import { useOutputMinimapModel } from "@hooks/useOutputMinimapModel";
import type { OutputMessage } from "@utils/outputProjection";
import type { OutputRenderRow } from "@utils/outputRows";

const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 2 } as const;

function makeMessage(timestamp: number): OutputMessage {
  return {
    type: OUTPUT_MESSAGE_TYPES.STATUS,
    target,
    timestamp,
    data: {
      message: "still working",
      severity: "info",
      timestamp: "12:00:00",
      timestampMs: timestamp,
    },
  } as OutputMessage;
}

function renderModel(allMessages: OutputMessage[], hiddenAtMs: number) {
  return renderHook(() =>
    useOutputMinimapModel({
      allMessages,
      allowUndoActions: false,
      finalStep: null,
      finalStepWorkspaceSnapshots: {},
      firstRowIndexByTarget: new Map([["queue:2", 0]]),
      hiddenAtMs: { "queue:2": hiddenAtMs },
      hiddenTargetKeys: ["queue:2"],
      historyOutputs: null,
      isViewingHistory: false,
      lastCliIndexPerStep: new Map(),
      onOpenMinimapRedoDialog: vi.fn(),
      onOpenMinimapUndoDialog: vi.fn(),
      outputFontSize: 14,
      rowLayout: {
        rowStartsByIndex: [0],
        rowStartsByKey: new Map(),
        totalSize: 40,
      },
      rows: [] as OutputRenderRow[],
      stepOutputsMap: new Map(),
      steps: [],
      undoRecords: {},
      uniqueStepTargets: [target],
      workspaceSnapshots: {},
    })
  );
}

describe("useOutputMinimapModel hidden activity", () => {
  it("marks a hidden target active when newer output arrives", () => {
    const { result } = renderModel([makeMessage(200)], 100);

    expect(result.current.minimapSteps[0]).toMatchObject({
      hidden: true,
      hasHiddenActivity: true,
    });
  });

  describe("useOutputMinimapModel interleaved activity", () => {
    it("exposes first/latest activity markers without making a step contiguous", () => {
      const targetA = {
        kind: FINAL_STEP_PHASES.QUEUE,
        index: 0,
      } as const;
      const targetB = {
        kind: FINAL_STEP_PHASES.QUEUE,
        index: 1,
      } as const;
      const activityMessages = [targetA, targetB, targetA].map(
        (messageTarget, index): OutputMessage => ({
          type: OUTPUT_MESSAGE_TYPES.STATUS,
          target: messageTarget,
          timestamp: 1000 + index,
          sequence: index,
          data: {
            message: `activity-${index}`,
            severity: "info",
            timestamp: "12:00:00",
            timestampMs: 1000 + index,
          },
          isActivity: true,
          activityKey: `activity-${index}`,
          activityKind: OUTPUT_ACTIVITY_KINDS.STATUS,
        })
      );
      const rows = [
        {
          key: "queue:0:anchor",
          rowKind: "step-anchor",
          target: targetA,
          estimateSize: 1,
        },
        {
          key: "a1",
          rowKind: "status",
          target: targetA,
          activityKey: "activity-0",
          estimateSize: 36,
        },
        {
          key: "queue:1:anchor",
          rowKind: "step-anchor",
          target: targetB,
          estimateSize: 1,
        },
        {
          key: "b1",
          rowKind: "status",
          target: targetB,
          activityKey: "activity-1",
          estimateSize: 36,
        },
        {
          key: "a2",
          rowKind: "status",
          target: targetA,
          activityKey: "activity-2",
          estimateSize: 36,
        },
      ] as OutputRenderRow[];

      const { result } = renderHook(() =>
        useOutputMinimapModel({
          allMessages: activityMessages,
          allowUndoActions: false,
          anchorRowIndexByTarget: new Map([
            ["queue:0", 0],
            ["queue:1", 2],
          ]),
          finalStep: null,
          finalStepWorkspaceSnapshots: {},
          firstRowIndexByTarget: new Map([
            ["queue:0", 0],
            ["queue:1", 2],
          ]),
          hiddenAtMs: {},
          hiddenTargetKeys: [],
          historyOutputs: null,
          isViewingHistory: false,
          lastCliIndexPerStep: new Map(),
          onOpenMinimapRedoDialog: vi.fn(),
          onOpenMinimapUndoDialog: vi.fn(),
          outputFontSize: 14,
          rowLayout: {
            rowStartsByIndex: [0, 10, 50, 60, 100],
            rowStartsByKey: new Map(),
            totalSize: 140,
          },
          rows,
          stepOutputsMap: new Map(),
          steps: [],
          undoRecords: {},
          uniqueStepTargets: [targetA, targetB],
          workspaceSnapshots: {},
        })
      );

      expect(result.current.minimapSteps[0]).toMatchObject({
        firstMessageIndex: 0,
        firstActivityRowIndex: 1,
        latestActivityRowIndex: 4,
        firstActivityScrollFraction: 10 / 140,
        latestActivityScrollFraction: 100 / 140,
        selected: false,
      });
      expect(result.current.minimapSteps[1]).toMatchObject({
        firstActivityRowIndex: 3,
        latestActivityRowIndex: 3,
      });
    });

    it("highlights the visible target when a filter selects one writer", () => {
      const visibleTarget = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
      const hiddenTarget = { kind: FINAL_STEP_PHASES.QUEUE, index: 1 } as const;
      const { result } = renderHook(() =>
        useOutputMinimapModel({
          allMessages: [makeMessage(100)],
          allowUndoActions: false,
          finalStep: null,
          finalStepWorkspaceSnapshots: {},
          firstRowIndexByTarget: new Map([
            ["queue:0", 0],
            ["queue:1", 1],
          ]),
          hiddenAtMs: {},
          hiddenTargetKeys: ["queue:1"],
          historyOutputs: null,
          isViewingHistory: false,
          lastCliIndexPerStep: new Map(),
          onOpenMinimapRedoDialog: vi.fn(),
          onOpenMinimapUndoDialog: vi.fn(),
          outputFontSize: 14,
          rowLayout: {
            rowStartsByIndex: [0, 10],
            rowStartsByKey: new Map(),
            totalSize: 40,
          },
          rows: [] as OutputRenderRow[],
          stepOutputsMap: new Map(),
          steps: [],
          undoRecords: {},
          uniqueStepTargets: [visibleTarget, hiddenTarget],
          workspaceSnapshots: {},
        })
      );

      expect(result.current.minimapSteps[0]?.selected).toBe(true);
      expect(result.current.minimapSteps[1]?.selected).toBe(false);
    });
  });

  it("does not mark a target active for output that predates hiding", () => {
    const { result } = renderModel([makeMessage(100)], 100);

    expect(result.current.minimapSteps[0]).toMatchObject({
      hidden: true,
      hasHiddenActivity: false,
    });
  });
});
