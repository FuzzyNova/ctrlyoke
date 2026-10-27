import { describe, expect, it } from "vitest";
import { OUTPUT_ROW_KINDS } from "@root/types/DashboardConstants";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { estimateOutputRowHeight, type CliHeaderRow } from "@utils/outputRows";

const FONT_SIZE = 13;
const LINE_HEIGHT = 12 * 1.4; // sm font (12) × body line-height

function header(withChanges: boolean): CliHeaderRow {
  return {
    key: `header-${withChanges}`,
    rowKind: OUTPUT_ROW_KINDS.CLI_HEADER,
    target: { kind: FINAL_STEP_PHASES.QUEUE, index: 1 },
    estimateSize: 40,
    groupStart: true,
    output: { elapsed: 0, isStreaming: false },
    stepIndex: 1,
    isFinalStep: false,
    stepLabel: "Step 2",
    stepName: "Verify awaiting-input mapping",
    attemptIndex: 0,
    runIndex: 0,
    ...(withChanges && {
      promptUndo: {
        workspacePath: "/repo",
        allStepOutputs: [],
        summary: {
          total: 2,
          undoable: 2,
          undone: 0,
          blocked: 0,
          label: "View 2 changes",
          compactLabel: "View 2",
          title: "2 files changed",
        },
      },
    }),
  };
}

describe("CLI header height estimate", () => {
  it("keeps the change viewer on the title's line in a wide pane", () => {
    expect(estimateOutputRowHeight(header(true), FONT_SIZE, 1200)).toBe(
      estimateOutputRowHeight(header(false), FONT_SIZE, 1200)
    );
  });

  it("wraps the title beside a two-line actions column in a narrow pane", () => {
    const wide = estimateOutputRowHeight(header(true), FONT_SIZE, 1200);
    const narrow = estimateOutputRowHeight(header(true), FONT_SIZE, 340);
    // At least hide + pin over the change viewer: one more line plus gap-y-1.
    expect(narrow - wide).toBeGreaterThanOrEqual(LINE_HEIGHT + 4);
    expect(narrow).toBeGreaterThanOrEqual(
      estimateOutputRowHeight(header(false), FONT_SIZE, 340)
    );
  });
});
