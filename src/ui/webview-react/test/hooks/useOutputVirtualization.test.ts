import { describe, expect, it } from "vitest";
import { shouldCompensateOutputRowMeasurement } from "@hooks/useOutputVirtualization";

const idleAboveViewportMeasurement = {
  hasRecentScrollEvent: false,
  isBulkRemeasureInProgress: false,
  isMeasurementFlushInProgress: false,
  isPostNavigationSettling: false,
  isRowResizeSuppressed: false,
  itemIndex: 4,
  lastObservedScrollTop: 500,
  pendingNavigation: false,
  scrollTop: 500,
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
    ["a pending programmatic scroll event", { lastObservedScrollTop: 450 }],
  ])("does not compensate during %s", (_label, override) => {
    expect(
      shouldCompensateOutputRowMeasurement({
        ...idleAboveViewportMeasurement,
        ...override,
      })
    ).toBe(false);
  });
});
