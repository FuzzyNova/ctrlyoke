/**
 * Guards the workflow row's width budget.
 *
 * Every row is three lines (name, then two of metadata); the only remaining
 * breakpoint is WORKFLOW_DROPDOWN_COMPACT_WIDTH, below which the badge drops
 * to its icon-only form. Widening a track without moving that breakpoint
 * collapses the name column — the layout's only flexible track — toward zero,
 * after which the `max-content` badge cell wraps and the row grows past the
 * height the virtualizer estimated.
 */
import { describe, it, expect } from "vitest";
import {
  resolveWorkflowRowTier,
  WORKFLOW_DROPDOWN_COMPACT_WIDTH,
  WORKFLOW_DROPDOWN_TARGET_WIDTH,
  WORKFLOW_ROW_TRACKS,
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
    // separate scroll regions; anything content-sized beside their metadata
    // would move where one region's metadata truncates. Three 24px icon
    // buttons plus two 4px gaps.
    expect(WORKFLOW_ROW_TRACKS.actions).toBeGreaterThanOrEqual(24 * 3 + 8);
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
 * harness icon, the run indicator and the state badge. The action rail sits
 * beside the metadata lines, never beside the name.
 */
function stackedFirstLineCost(badgeWidth: number): number {
  return (
    16 + // row px-2
    WORKFLOW_ROW_TRACKS.harness +
    3 * 4 + // column gaps: icon→label→run indicator→badge
    WORKFLOW_ROW_TRACKS.runIndicator +
    badgeWidth
  );
}

/**
 * A metadata line's fixed cost at full text: it spans the run-indicator
 * column and gives up only the badge column, which holds the rail.
 */
const metaLineCost =
  16 + // row px-2
  WORKFLOW_ROW_TRACKS.harness +
  3 * 4 + // column gaps
  WORKFLOW_ROW_TRACKS.state;

/**
 * A metadata line's fixed cost at the compact tier, where the rail reaches
 * into the run-indicator column beside the icon-only badge.
 */
const compactMetaLineCost =
  16 + // row px-2
  WORKFLOW_ROW_TRACKS.harness +
  2 * 4 + // column gaps up to the run-indicator column
  Math.max(
    WORKFLOW_ROW_TRACKS.actions,
    WORKFLOW_ROW_TRACKS.runIndicator + 4 + 16 + BADGE_PADDING
  );

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
    // the name legible beside the run indicator once the badge is an icon.
    expect(240 - stackedFirstLineCost(iconBadge)).toBeGreaterThanOrEqual(60);
  });

  it("does not charge the name for the action rail", () => {
    // The regression the rail's placement fixes: on a narrow sidebar the
    // trailing controls took half the first line. Only the run indicator,
    // which reads with the badge, shares the name's line.
    expect(
      320 - stackedFirstLineCost(WORKFLOW_ROW_TRACKS.state)
    ).toBeGreaterThan(120);
  });

  it("leaves each metadata line readable beside the action rail", () => {
    // Each line holds two parts (steps · time ago, or usage · run time), so
    // a narrow popup still shows both in full.
    expect(240 - compactMetaLineCost).toBeGreaterThanOrEqual(60);
    expect(
      WORKFLOW_DROPDOWN_COMPACT_WIDTH - metaLineCost
    ).toBeGreaterThanOrEqual(180);
    expect(400 - metaLineCost).toBeGreaterThanOrEqual(220);
  });

  it("keeps a full-text badge at least as wide as the action rail", () => {
    // At full text the rail must fit wholly under the badge: the metadata
    // lines span the run-indicator column there, and a wider rail would
    // overlap their ends.
    expect(WORKFLOW_ROW_TRACKS.state).toBeGreaterThanOrEqual(
      WORKFLOW_ROW_TRACKS.actions
    );
  });
});
