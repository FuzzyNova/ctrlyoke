import { describe, it, expect } from "vitest";
import {
  FINAL_STEP_PHASES,
  OUTPUT_ROW_KINDS,
} from "@root/types/DashboardConstants";
import type { CliEvent } from "@root/types/CliOutputTypes";
import { describeRowTiming } from "@utils/outputRowTiming";
import type { OutputRenderRow, StructuredEventRow } from "@utils/outputRows";

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

  it("returns undefined without a start time or for other row kinds", () => {
    expect(describeRowTiming(eventRow({}))).toBeUndefined();
    const other = {
      ...eventRow({ timestamp: 1 }),
      rowKind: OUTPUT_ROW_KINDS.STATS,
    } as unknown as OutputRenderRow;
    expect(describeRowTiming(other)).toBeUndefined();
  });
});
