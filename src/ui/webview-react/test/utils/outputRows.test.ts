import { describe, expect, it } from "vitest";
import type { WorkflowStep } from "@store/workflowStore";
import { buildOutputRows } from "@utils/outputRows";
import type { OutputMessage } from "@utils/outputProjection";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "@/types/cliEvents";
import { FINAL_STEP_PHASES } from "@/types/messages";

describe("outputRows", () => {
  const steps = [{ name: "Analyze code" } as WorkflowStep];

  it("projects queue output into flat rows in render order", () => {
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Analyze code",
          cliCommand: "copilot -p",
          response: "Done.",
          elapsed: 1.2,
          isStreaming: false,
          tokens: { prompt: 10, completion: 5 },
        },
      },
    ];

    const result = buildOutputRows({
      allMessages,
      steps,
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: true,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      defaultDiffCollapsed: false,
    });

    expect(result.rows.map((row) => row.rowKind)).toEqual([
      "step-anchor",
      "cli-header",
      "prompt",
      "cli-command",
      "plain-response",
      "stats",
    ]);
    expect(result.firstRowIndexByTarget.get("queue:0")).toBe(0);
    expect(result.lastCliIndexPerStep.get("queue:0")).toBe(0);
  });

  it("keeps diff row keys stable when unrelated streaming chunks change", () => {
    const allMessages: OutputMessage[] = [
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        timestamp: 1000,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Edit file",
          response: "",
          elapsed: 0.5,
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
                      lines: ["-const a = 1;", "+const a = 2;"],
                    },
                  ],
                },
              },
            ],
            metadata: {},
          },
        },
      },
      {
        type: "cli",
        target: { kind: FINAL_STEP_PHASES.QUEUE, index: 1 },
        timestamp: 1001,
        attemptIndex: 0,
        runIndex: 0,
        data: {
          prompt: "Stream text",
          response: "",
          elapsed: 0,
          isStreaming: true,
        },
      },
    ];

    const baseInput = {
      allMessages,
      steps: [{ name: "Edit file" }, { name: "Stream text" }] as WorkflowStep[],
      finalStep: null,
      finalStepStreamingChunks: {},
      isExecutionActive: true,
      allowUndoActions: false,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {},
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map<string, boolean>(),
      defaultDiffCollapsed: false,
    };

    const first = buildOutputRows({
      ...baseInput,
      streamingChunks: { 1: "alpha" },
    });
    const second = buildOutputRows({
      ...baseInput,
      streamingChunks: { 1: "beta" },
    });

    const firstDiffRow = first.rows.find(
      (row) => row.rowKind === "structured-event" && row.diff
    );
    const secondDiffRow = second.rows.find(
      (row) => row.rowKind === "structured-event" && row.diff
    );

    expect(firstDiffRow?.key).toBe(secondDiffRow?.key);
    expect(firstDiffRow?.rowKind).toBe("structured-event");
    expect(secondDiffRow?.rowKind).toBe("structured-event");
  });
});
