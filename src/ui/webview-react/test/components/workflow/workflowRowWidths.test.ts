/**
 * Guards the flat workflow row's width budget.
 *
 * WORKFLOW_DROPDOWN_NARROW_WIDTH is *derived* from WORKFLOW_ROW_TRACKS: widen a
 * track without moving the breakpoint and the name column — the layout's only
 * flexible track — collapses toward zero, after which the `max-content` cells
 * wrap and every row grows past the height the virtualizer estimated. That is
 * the failure the first narrow screenshots showed, so it gets a test rather
 * than a comment.
 */
import { describe, it, expect } from "vitest";
import {
  WORKFLOW_DROPDOWN_NARROW_WIDTH,
  WORKFLOW_DROPDOWN_TARGET_WIDTH,
  WORKFLOW_ROW_TRACKS,
} from "@/constants";

// text-xs (12px): uppercase badge glyphs run ~7.0px, body text ~6.4px.
const BADGE_CHAR = 7.0;
const BODY_CHAR = 6.4;
const BADGE_PADDING = 12; // px-1.5 either side

/** Everything the flat row spends before the name column gets a pixel. */
function fixedCostBeforeName(widestStepLabel: string): number {
  return (
    16 + // row px-2
    WORKFLOW_ROW_TRACKS.harness +
    WORKFLOW_ROW_TRACKS.glyph +
    WORKFLOW_ROW_TRACKS.state +
    WORKFLOW_ROW_TRACKS.time +
    5 * 4 + // column gaps between the six tracks
    WORKFLOW_ROW_TRACKS.runIndicator +
    WORKFLOW_ROW_TRACKS.actions +
    2 * 8 + // gaps between the primary button and each trailing rail
    widestStepLabel.length * BODY_CHAR
  );
}

describe("flat workflow row width budget", () => {
  it("sizes the state track for the longest execution state", () => {
    // "CANCELLING" is the longest EXECUTION_STATES label.
    expect(WORKFLOW_ROW_TRACKS.state).toBeGreaterThanOrEqual(
      "CANCELLING".length * BADGE_CHAR + BADGE_PADDING
    );
  });

  it("sizes the time track for the longest verbose relative stamp", () => {
    // formatRelativeTimeVerbose's longest output shape.
    expect(WORKFLOW_ROW_TRACKS.time).toBeGreaterThanOrEqual(
      "59 minutes ago".length * BODY_CHAR
    );
  });

  it("keeps the trailing rails fixed so row kinds stay column-aligned", () => {
    // Running rows (pause/stop) and recent rows (favourite/remove) sit in
    // separate scroll regions; their trailing siblings are outside the grid,
    // so anything content-sized there would offset one region's state and
    // time columns from the other's. Two 20px icon buttons plus a 4px gap.
    expect(WORKFLOW_ROW_TRACKS.actions).toBeGreaterThanOrEqual(20 * 2 + 4);
    expect(WORKFLOW_ROW_TRACKS.runIndicator).toBeGreaterThanOrEqual(
      "Run 1042".length * BODY_CHAR
    );
  });

  it("leaves the name column readable down to the stacking breakpoint", () => {
    const nameWidth =
      WORKFLOW_DROPDOWN_NARROW_WIDTH - fixedCostBeforeName("12 steps");
    expect(nameWidth).toBeGreaterThanOrEqual(120);
  });

  it("opens wide enough on desktop to stay in the flat layout", () => {
    expect(WORKFLOW_DROPDOWN_TARGET_WIDTH).toBeGreaterThanOrEqual(
      WORKFLOW_DROPDOWN_NARROW_WIDTH
    );
  });
});
