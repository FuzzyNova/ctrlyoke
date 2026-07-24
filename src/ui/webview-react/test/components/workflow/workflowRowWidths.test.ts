/**
 * Guards the workflow row's width budget at every tier.
 *
 * Both breakpoints are *derived* from WORKFLOW_ROW_TRACKS: widen a track
 * without moving them and the name column — the layout's only flexible track —
 * collapses toward zero, after which the `max-content` cells wrap and every row
 * grows past the height the virtualizer estimated. That is the failure the
 * narrow screenshots showed twice over, so it gets a test rather than a
 * comment.
 */
import { describe, it, expect } from "vitest";
import {
  resolveWorkflowRowTier,
  WORKFLOW_DROPDOWN_COMPACT_WIDTH,
  WORKFLOW_DROPDOWN_NARROW_WIDTH,
  WORKFLOW_DROPDOWN_TARGET_WIDTH,
  WORKFLOW_ROW_TRACKS,
} from "@/constants";

// text-xs (12px): uppercase badge glyphs run ~7.0px, body text ~6.4px.
const BADGE_CHAR = 7.0;
const BODY_CHAR = 6.4;
const BADGE_PADDING = 12; // px-1.5 either side
/** The run indicator's non-label cost: px-1, a gap-0.5, and the chevron. */
const INDICATOR_CHROME = 8 + 2 + 10;

/** Everything the flat row spends before the name column gets a pixel. */
function fixedCostBeforeName(widestStepLabel: string): number {
  return (
    16 + // row px-2
    WORKFLOW_ROW_TRACKS.harness +
    WORKFLOW_ROW_TRACKS.glyph +
    WORKFLOW_ROW_TRACKS.state +
    WORKFLOW_ROW_TRACKS.time +
    5 * 4 + // column gaps between the six tracks
    WORKFLOW_ROW_TRACKS.runIndicator.flat +
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
    // Each tier's track must fit the label form that tier renders.
    expect(WORKFLOW_ROW_TRACKS.runIndicator.flat).toBeGreaterThanOrEqual(
      "Run 1042".length * BODY_CHAR
    );
    expect(WORKFLOW_ROW_TRACKS.runIndicator.stacked).toBeGreaterThanOrEqual(
      "#1042".length * BODY_CHAR + INDICATOR_CHROME
    );
    // Reserving the *flat* width on a stacked row is what parked a visible
    // hole beside every badge; it must genuinely be the tighter track.
    expect(WORKFLOW_ROW_TRACKS.runIndicator.stacked).toBeLessThan(
      WORKFLOW_ROW_TRACKS.runIndicator.flat
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

/**
 * Everything a *stacked* row's first line spends before the name gets a pixel.
 * The second line is free — it spans the name and badge columns together — so
 * the first line is what the breakpoint has to be sized for.
 */
function stackedFirstLineCost(badgeWidth: number): number {
  return (
    16 + // row px-2
    2 * 8 + // gaps to the run-indicator and action rails
    WORKFLOW_ROW_TRACKS.harness +
    2 * 4 + // column gaps: icon→label, label→badge
    badgeWidth +
    WORKFLOW_ROW_TRACKS.runIndicator.stacked +
    WORKFLOW_ROW_TRACKS.actions
  );
}

describe("stacked workflow row width budget", () => {
  it("orders the tiers so compact is always also stacked", () => {
    expect(WORKFLOW_DROPDOWN_COMPACT_WIDTH).toBeLessThan(
      WORKFLOW_DROPDOWN_NARROW_WIDTH
    );
    expect(resolveWorkflowRowTier(WORKFLOW_DROPDOWN_TARGET_WIDTH)).toBe("flat");
    expect(resolveWorkflowRowTier(WORKFLOW_DROPDOWN_NARROW_WIDTH - 1)).toBe(
      "stacked"
    );
    expect(resolveWorkflowRowTier(WORKFLOW_DROPDOWN_COMPACT_WIDTH - 1)).toBe(
      "compact"
    );
  });

  it("keeps the name readable while the badge still carries text", () => {
    // The full-text badge is the widest fixed item on the stacked first line;
    // "CANCELLING" is the worst case, so the state track's width is its cost.
    const nameWidth =
      WORKFLOW_DROPDOWN_COMPACT_WIDTH -
      stackedFirstLineCost(WORKFLOW_ROW_TRACKS.state);
    expect(nameWidth).toBeGreaterThanOrEqual(140);
  });

  it("buys back enough width by dropping the badge to its icon", () => {
    // A codicon plus the badge's own px-1.5 padding.
    const iconBadge = 16 + BADGE_PADDING;
    const reclaimed = WORKFLOW_ROW_TRACKS.state - iconBadge;
    expect(reclaimed).toBeGreaterThanOrEqual(50);
    // Even a 240px popup — the narrowest VS Code sidebar allows — still leaves
    // the name legible once the badge is an icon.
    expect(240 - stackedFirstLineCost(iconBadge)).toBeGreaterThanOrEqual(60);
  });
});
