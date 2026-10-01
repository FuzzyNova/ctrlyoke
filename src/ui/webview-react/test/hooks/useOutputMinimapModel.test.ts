import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FINAL_STEP_PHASES,
  OUTPUT_MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import { useOutputMinimapModel } from "@hooks/useOutputMinimapModel";
import type { OutputMessage } from "@utils/outputProjection";
import type { OutputRenderRow } from "@utils/outputRows";
import type { WorkspaceSnapshot } from "@root/types/OutputHistoryTypes";

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

function renderModel(
  allMessages: OutputMessage[],
  hiddenAtMs: number,
  workspaceSnapshot?: WorkspaceSnapshot
) {
  const outputMessage = workspaceSnapshot
    ? ({
        type: "cli",
        target,
        timestamp: 201,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "prompt",
          response: "done",
          elapsed: 1,
          isStreaming: false,
          workingDirectory: "/repo",
        },
      } as OutputMessage)
    : undefined;
  const messages = outputMessage ? [...allMessages, outputMessage] : allMessages;
  return renderHook(() =>
    useOutputMinimapModel({
      allMessages: messages,
      allowUndoActions: workspaceSnapshot !== undefined,
      finalStep: null,
      finalStepWorkspaceSnapshots: {},
      firstRowIndexByTarget: new Map([["queue:2", 0]]),
      hiddenAtMs: { "queue:2": hiddenAtMs },
      hiddenTargetKeys: ["queue:2"],
      historyOutputs: null,
      isViewingHistory: false,
      lastCliIndexPerStep: outputMessage ? new Map([["queue:2", 1]]) : new Map(),
      onOpenMinimapDialog: vi.fn(),
      outputFontSize: 14,
      rowLayout: {
        rowStartsByIndex: [0],
        rowStartsByKey: new Map(),
        totalSize: 40,
      },
      rows: [] as OutputRenderRow[],
      stepOutputsMap: new Map(
        workspaceSnapshot
          ? [
              [
                "queue:2",
                [
                  {
                    prompt: "prompt",
                    response: "done",
                    elapsed: 1,
                    isStreaming: false,
                    workingDirectory: "/repo",
                  },
                ],
              ],
            ]
          : []
      ),
      steps: [],
      undoRecords: {},
      uniqueStepTargets: [target],
      workspaceSnapshots: workspaceSnapshot ? { 2: workspaceSnapshot } : {},
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
    it("highlights the visible target when a filter selects one writer", () => {
      const visibleTarget = {
        kind: FINAL_STEP_PHASES.QUEUE,
        index: 0,
      } as const;
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
          onOpenMinimapDialog: vi.fn(),
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

  it("keeps changed-step flags from the snapshot index without file bodies", () => {
    const snapshot: WorkspaceSnapshot = {
      capturedAt: 1,
      strategy: "filesystem",
      changedFiles: [
        {
          path: "src/changed.ts",
          changeType: "created",
          contentAvailableOnDemand: true,
        },
      ],
    };
    const { result } = renderModel([makeMessage(200)], 100, snapshot);

    expect(result.current.minimapSteps[0]?.changeSummary).toMatchObject({
      total: 1,
    });
  });
});
