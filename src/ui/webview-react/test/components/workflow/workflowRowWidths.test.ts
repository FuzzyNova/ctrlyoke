/**
 * Guards the workflow row's width budget.
 *
 * Every row is two lines (name, then metadata); the only remaining breakpoint
 * is WORKFLOW_DROPDOWN_COMPACT_WIDTH, below which the badge drops to its
 * icon-only form and the run indicator to `#12`. Widening a track without
 * moving that breakpoint collapses the name column — the layout's only
 * flexible track — toward zero, after which the `max-content` badge cell
 * wraps and the row grows past the height the virtualizer estimated.
 */
import { describe, it, expect } from "vitest";
import {
  resolveWorkflowRowTier,
  WORKFLOW_DROPDOWN_COMPACT_WIDTH,
  WORKFLOW_DROPDOWN_TARGET_WIDTH,
  WORKFLOW_ROW_TRACKS,
  WORKFLOW_ROW_TRAILING_WIDTH,
} from "@/constants";

// text-xs (12px): uppercase badge glyphs run ~7.0px.
const BADGE_CHAR = 7.0;
const BADGE_PADDING = 12; // px-1.5 either side
/** The run indicator's non-label cost: px-1, a gap-0.5, and the chevron. */
const INDICATOR_CHROME = 8 + 2 + 10;

describe("workflow row width budget", () => {
  it("sizes the state track for the longest execution state", () => {
    // "CANCELLING" is the longest EXECUTION_STATES label.
    expect(WORKFLOW_ROW_TRACKS.state).toBeGreaterThanOrEqual(
      "CANCELLING".length * BADGE_CHAR + BADGE_PADDING
    );
  });

  it("keeps the trailing rails fixed so row kinds stay column-aligned", () => {
    // Running rows (pause/stop) and recent rows (favourite/remove) sit in
    // separate scroll regions; anything content-sized at the end of their
    // metadata line would move where one region's metadata truncates and
    // where its run indicator sits. Three 20px icon buttons plus two 4px gaps.
    expect(WORKFLOW_ROW_TRACKS.actions).toBeGreaterThanOrEqual(20 * 3 + 8);
    expect(WORKFLOW_ROW_TRACKS.runIndicator).toBeGreaterThanOrEqual(
      "#1042".length * 6.4 + INDICATOR_CHROME
    );
  });

  it("orders the tiers so compact is the narrower one", () => {
    expect(resolveWorkflowRowTier(WORKFLOW_DROPDOWN_COMPACT_WIDTH)).toBe(
      "stacked"
    );
    expect(resolveWorkflowRowTier(WORKFLOW_DROPDOWN_COMPACT_WIDTH - 1)).toBe(
      "compact"
    );
  });

  it("opens wide enough on desktop to keep full-text badges", () => {
    expect(WORKFLOW_DROPDOWN_TARGET_WIDTH).toBeGreaterThanOrEqual(
      WORKFLOW_DROPDOWN_COMPACT_WIDTH
    );
  });
});

/**
 * Everything the row's first line spends before the name gets a pixel: the
 * harness icon and the state badge only. The run indicator and action rail
 * sit at the end of the second line, never beside the name.
 */
function stackedFirstLineCost(badgeWidth: number): number {
  return (
    16 + // row px-2
    WORKFLOW_ROW_TRACKS.harness +
    3 * 4 + // column gaps: icon→label, through the slack track, →badge
    badgeWidth
  );
}

/** The second line's fixed cost before the metadata gets a pixel. */
const secondLineCost =
  16 + // row px-2
  WORKFLOW_ROW_TRACKS.harness +
  3 * 4 + // column gaps
  WORKFLOW_ROW_TRAILING_WIDTH;

describe("stacked first-line width budget", () => {
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

  it("does not charge the name for the run indicator or action rail", () => {
    // The regression this layout fixes: on a narrow sidebar the trailing
    // controls took half the first line. Now a 290px popup keeps well over
    // half its width for the name even with a full-text badge.
    expect(
      290 - stackedFirstLineCost(WORKFLOW_ROW_TRACKS.state)
    ).toBeGreaterThan(145);
  });

  it("leaves the metadata line readable beside the trailing controls", () => {
    expect(240 - secondLineCost).toBeGreaterThanOrEqual(60);
  });
});
