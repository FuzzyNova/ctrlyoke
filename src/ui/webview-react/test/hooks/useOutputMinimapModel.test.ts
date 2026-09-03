import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FINAL_STEP_PHASES,
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

  it("does not mark a target active for output that predates hiding", () => {
    const { result } = renderModel([makeMessage(100)], 100);

    expect(result.current.minimapSteps[0]).toMatchObject({
      hidden: true,
      hasHiddenActivity: false,
    });
  });
});
