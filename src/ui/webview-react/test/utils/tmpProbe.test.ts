import { describe, expect, it } from "vitest";
import type { WorkflowStep } from "@store/workflowStore";
import { buildOutputRows } from "@utils/outputRows";
import { mapOrderedHistoryEntriesToMessages } from "@utils/outputProjection";
import { CLI_EVENT_TYPES } from "@/types/cliEvents";
import { FINAL_STEP_PHASES, OUTPUT_ACTIVITY_KINDS } from "@root/types/DashboardConstants";

describe("probe", () => {
  it("counts activityFirst for one target", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 } as const;
    const allMessages = mapOrderedHistoryEntriesToMessages(
      [],
      [1, 2, 3, 4, 5].map((n) => ({
        timestampMs: 1000 + n, sequence: n, target, runIndex: 0, attemptIndex: 0,
        kind: OUTPUT_ACTIVITY_KINDS.STRUCTURED,
        events: [{ type: CLI_EVENT_TYPES.BASH_COMMAND, data: { command: `echo ${n}`, output: `${n}` } }],
      }))
    );
    const result = buildOutputRows({
      allMessages, steps: [{ name: "One" }] as WorkflowStep[], finalStep: null,
      streamingChunks: {}, finalStepStreamingChunks: {}, isExecutionActive: false,
      allowUndoActions: false, isViewingHistory: false, historyOutputs: null,
      workspaceSnapshots: {}, finalStepWorkspaceSnapshots: {}, undoRecords: {},
      diffCollapseState: new Map(), diffExpansionState: new Map(),
      toolCallExpansionState: new Map(), defaultDiffCollapsed: false,
    });
    console.log("ROWS:", result.rows.map(r => `${r.rowKind}${r.activityFirst ? "[FIRST]" : ""}${r.activityContinuation ? "[cont]" : ""}`).join("\n  "));
    console.log("activityFirst count:", result.rows.filter(r => r.activityFirst).length);
    expect(true).toBe(true);
  });
});
