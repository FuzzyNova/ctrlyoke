import { describe, expect, it } from "vitest";
import { shouldCompensateOutputRowMeasurement } from "@hooks/useOutputVirtualization";

const idleAboveViewportMeasurement = {
  hasPendingDirectScrollWrite: false,
  hasRecentScrollEvent: false,
  isBulkRemeasureInProgress: false,
  isMeasurementFlushInProgress: false,
  isPostNavigationSettling: false,
  isRowResizeSuppressed: false,
  itemIndex: 4,
  pendingNavigation: false,
  targetRowIndex: 5,
};

describe("shouldCompensateOutputRowMeasurement", () => {
  it("lets the virtualizer compensate an idle above-viewport measurement", () => {
    expect(
      shouldCompensateOutputRowMeasurement(idleAboveViewportMeasurement)
    ).toBe(true);
  });

  it.each([
    ["recent user scrolling", { hasRecentScrollEvent: true }],
    ["a bulk remeasure", { isBulkRemeasureInProgress: true }],
    ["a deferred measurement flush", { isMeasurementFlushInProgress: true }],
    ["pending navigation", { pendingNavigation: true }],
    ["post-navigation settling", { isPostNavigationSettling: true }],
    ["an explicit row resize", { isRowResizeSuppressed: true }],
    ["the anchored row itself", { itemIndex: 5 }],
    ["a row after the anchor", { itemIndex: 6 }],
    ["a bottom target", { targetRowIndex: null }],
    [
      "an unobserved direct scrollTop write",
      { hasPendingDirectScrollWrite: true },
    ],
  ])("does not compensate during %s", (_label, override) => {
    expect(
      shouldCompensateOutputRowMeasurement({
        ...idleAboveViewportMeasurement,
        ...override,
      })
    ).toBe(false);
  });

  // Regression: the staleness guard used to compare the live scrollTop against
  // the last *observed* one. The virtualizer's own compensation writes scrollTop
  // synchronously, so after the first compensated row every later above-anchor
  // row in the same measurement burst was refused and its height delta shifted
  // the viewport instead.
  it("compensates every above-anchor row in one measurement burst", () => {
    for (const itemIndex of [4, 3, 2]) {
      expect(
        shouldCompensateOutputRowMeasurement({
          ...idleAboveViewportMeasurement,
          itemIndex,
        })
      ).toBe(true);
    }
  });
});
