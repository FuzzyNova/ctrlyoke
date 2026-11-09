import { describe, expect, it } from "vitest";
import { OUTPUT_ROW_KINDS } from "@root/types/DashboardConstants";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { estimateOutputRowHeight, type CliHeaderRow } from "@utils/outputRows";

const FONT_SIZE = 13;

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
  // The header never wraps, so every variant is one line plus its chrome.
  const ONE_LINE = estimateOutputRowHeight(header(false), FONT_SIZE, 1200);

  it("is one line whatever the pane width", () => {
    for (const width of [1200, 340, 240]) {
      expect(estimateOutputRowHeight(header(false), FONT_SIZE, width)).toBe(
        ONE_LINE
      );
      expect(estimateOutputRowHeight(header(true), FONT_SIZE, width)).toBe(
        ONE_LINE
      );
    }
  });

  it("does not grow with a long step name or a narrow layout", () => {
    expect(
      estimateOutputRowHeight(
        {
          ...header(true),
          stepName: "Verify awaiting-input mapping ".repeat(16),
          narrowLayout: true,
        },
        FONT_SIZE,
        240
      )
    ).toBe(ONE_LINE);
  });
});
