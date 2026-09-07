import { describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "@store/workflowStore";
import { mapOrderedHistoryEntriesToMessages } from "@utils/outputProjection";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "@/types/cliEvents";
import { FINAL_STEP_PHASES, OUTPUT_ACTIVITY_KINDS } from "@/types/messages";
import {
  FILE_OPERATION_KINDS,
  OUTPUT_ROW_KINDS,
} from "@root/types/DashboardConstants";

// Spy on the real implementation so the assertion is about *call count*, not
// about a stubbed return value — the labels below still come from the genuine
// undo computation.
const undoSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@utils/promptUndo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@utils/promptUndo")>();
  return {
    ...actual,
    computePromptUndoActions: (
      ...args: Parameters<typeof actual.computePromptUndoActions>
    ) => {
      undoSpy.calls++;
      return actual.computePromptUndoActions(...args);
    },
  };
});

const { buildOutputRows } = await import("@utils/outputRows");

describe("buildOutputRows undo-action memoization", () => {
  /**
   * One target, one attempt, many streamed activity slices — the shape a long
   * step produces. Undo actions depend only on per-target inputs
   * (`stepOutputsMap`, the workspace snapshot, the undo record), all of which
   * are settled before the row loop runs, so the answer must be derived once
   * per target rather than once per message.
   */
  const buildRows = (sliceCount: number) => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const allMessages = mapOrderedHistoryEntriesToMessages(
      [
        {
          kind: "cli" as const,
          timestampMs: 1000,
          sequence: 0,
          target,
          runIndex: 0,
          attemptIndex: 0,
          cliOutput: {
            prompt: "Edit the file",
            response: "done",
            elapsed: 1,
            isStreaming: false,
            workingDirectory: "/repo",
            structured: {
              metadata: {},
              events: [
                {
                  type: CLI_EVENT_TYPES.FILE_EDIT,
                  data: {
                    path: "src/file.ts",
                    oldContent: "before",
                    newContent: "after",
                    status: OPERATION_STATUS.COMPLETED,
                  },
                },
              ],
            },
          },
        },
      ],
      Array.from({ length: sliceCount }, (_unused, offset) => ({
        timestampMs: 1001 + offset,
        sequence: 1 + offset,
        target,
        runIndex: 0,
        attemptIndex: 0,
        kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
        events: [
          {
            type: CLI_EVENT_TYPES.BASH_COMMAND,
            data: { command: `echo ${offset}`, output: `${offset}` },
          },
        ],
      }))
    );

    return buildOutputRows({
      allMessages,
      steps: [{ name: "Edit" }] as WorkflowStep[],
      finalStep: null,
      streamingChunks: {},
      finalStepStreamingChunks: {},
      isExecutionActive: false,
      allowUndoActions: true,
      isViewingHistory: false,
      historyOutputs: null,
      workspaceSnapshots: {
        0: {
          capturedAt: 1000,
          strategy: "filesystem",
          changedFiles: [
            {
              path: "src/file.ts",
              changeType: FILE_OPERATION_KINDS.CREATED,
            },
          ],
        },
      },
      finalStepWorkspaceSnapshots: {},
      undoRecords: {},
      diffCollapseState: new Map(),
      diffExpansionState: new Map(),
      toolCallExpansionState: new Map(),
      defaultDiffCollapsed: false,
    });
  };

  it("computes a target's undo actions once regardless of how many messages it spans", () => {
    undoSpy.calls = 0;
    const few = buildRows(3);
    const callsForFewMessages = undoSpy.calls;

    undoSpy.calls = 0;
    const many = buildRows(60);
    const callsForManyMessages = undoSpy.calls;

    // The whole point: 20x the messages, same amount of undo computation.
    // Before this was memoized, `computePromptUndoActions` ran once per
    // message and cost 6 413 ms of a 6 527 ms build on an 18-step run.
    expect(callsForFewMessages).toBe(1);
    expect(callsForManyMessages).toBe(1);

    // And the memo must not change what is rendered.
    const undoLabel = (rows: ReturnType<typeof buildRows>["rows"]) =>
      rows.find(
        (row) =>
          row.rowKind === OUTPUT_ROW_KINDS.CLI_HEADER && row.promptUndo?.undo
      )?.promptUndo?.undo?.label;

    expect(undoLabel(few.rows)).toBe("Undo 1 change");
    expect(undoLabel(many.rows)).toBe(undoLabel(few.rows));
  });
});
