import { describe, it, expect } from "vitest";
import {
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  OUTPUT_ROW_KINDS,
  SCRIPT_OUTPUT_SOURCES,
} from "@root/types/DashboardConstants";
import type { CliEvent } from "@root/types/CliOutputTypes";
import { getHarnessDisplayName } from "@/types/messages";
import { describeRowTiming } from "@utils/outputRowTiming";
import { formatTimestamp } from "@utils/time";
import type {
  CliHeaderRow,
  OutputRenderRow,
  PlainResponseRow,
  StructuredEventRow,
} from "@utils/outputRows";

function eventRow(
  event: Partial<CliEvent>,
  target: StructuredEventRow["target"] = {
    kind: FINAL_STEP_PHASES.QUEUE,
    index: 2,
  }
): StructuredEventRow {
  return {
    key: "k",
    rowKind: OUTPUT_ROW_KINDS.STRUCTURED_EVENT,
    target,
    estimateSize: 10,
    event: { type: "bash_command", data: {}, ...event } as CliEvent,
    eventIndex: 0,
    rawTextOutput: false,
    hideDiff: false,
  };
}

describe("describeRowTiming", () => {
  it("reports start, duration and step for a completed event", () => {
    const text = describeRowTiming(
      eventRow({ timestamp: 1_000, completedTimestamp: 39_200 })
    );
    expect(text).toContain("Started:");
    expect(text).toContain("Took: 38s");
    expect(text).toContain("Step 3");
  });

  it("shows sub-second durations in milliseconds", () => {
    const text = describeRowTiming(
      eventRow({ timestamp: 1_000, completedTimestamp: 1_250 })
    );
    expect(text).toContain("Took: 250ms");
  });

  it("omits the duration when the event never completed", () => {
    const text = describeRowTiming(eventRow({ timestamp: 1_000 }));
    expect(text).toContain("Started:");
    expect(text).not.toContain("Took:");
  });

  it("covers plain response rows with a start time and step only", () => {
    const row: PlainResponseRow = {
      key: "p",
      rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
      target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
      estimateSize: 10,
      text: "hi",
      rawTextOutput: false,
      animated: false,
      timestampMs: 5_000,
    };
    const text = describeRowTiming(row);
    expect(text).toContain("Started:");
    expect(text).toContain("Step 1");
    expect(text).not.toContain("Took:");
    expect(
      describeRowTiming({ ...row, timestampMs: undefined })
    ).toBeUndefined();
  });

  describe("step headers", () => {
    function headerRow(overrides: Partial<CliHeaderRow> = {}): CliHeaderRow {
      return {
        key: "h",
        rowKind: OUTPUT_ROW_KINDS.CLI_HEADER,
        target: { kind: FINAL_STEP_PHASES.FINAL_STEP, index: 6 },
        estimateSize: 44,
        output: {
          elapsed: 0,
          isStreaming: false,
          timestampMs: 5_000,
          structured: {
            events: [],
            metadata: {
              harness: HARNESS_IDS.CLAUDE_CLI,
              model: "unlisted-model",
            },
          },
        },
        stepIndex: 6,
        isFinalStep: true,
        stepLabel: "Final Step Pass 7",
        stepName: "drain-backlog",
        attemptIndex: 1,
        runIndex: 0,
        narrowLayout: true,
        ...overrides,
      };
    }

    it("names the start, step, attempt, harness, model and changes", () => {
      const text = describeRowTiming(
        headerRow({
          promptUndo: {
            workspacePath: "/repo",
            allStepOutputs: [],
            summary: {
              total: 4,
              undoable: 4,
              undone: 0,
              blocked: 0,
              label: "View 4 changes",
              compactLabel: "View 4",
              title: "4 files changed",
            },
          },
        })
      );
      expect(text?.split("\n")).toEqual([
        `Started: ${formatTimestamp(5_000)}`,
        "Final Step Pass 7 · drain-backlog",
        "Retry 1",
        `Harness: ${getHarnessDisplayName(HARNESS_IDS.CLAUDE_CLI)}`,
        "Model: unlisted-model",
        "4 files changed",
      ]);
    });

    it("names a condition script by its condition", () => {
      const row = headerRow({ attemptIndex: 0, runIndex: 0 });
      const text = describeRowTiming({
        ...row,
        output: {
          ...row.output,
          structured: undefined,
          source: SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
        },
      });
      expect(text?.split("\n")).toEqual([
        `Started: ${formatTimestamp(5_000)}`,
        "Final Step Pass 7 · Pre-condition",
      ]);
    });
  });

  it("returns undefined without a start time or for other row kinds", () => {
    expect(describeRowTiming(eventRow({}))).toBeUndefined();
    const other = {
      ...eventRow({ timestamp: 1 }),
      rowKind: OUTPUT_ROW_KINDS.STATS,
    } as unknown as OutputRenderRow;
    expect(describeRowTiming(other)).toBeUndefined();
  });
});
