import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOutputVirtualization } from "@hooks/useOutputVirtualization";
import type { OutputRenderRow } from "@utils/outputRows";

function makeRows(count: number): OutputRenderRow[] {
  return Array.from({ length: count }, (_value, index) => ({
    key: `row-${index}`,
    rowKind: "plain-response" as const,
    target: { kind: "queue" as const, index: 0 },
    text: `response ${index}`,
    rawTextOutput: true,
    animated: false,
    estimateSize: 100,
  }));
}

function renderVirtualization(rows: OutputRenderRow[]) {
  const scrollElement = document.createElement("div");
  Object.defineProperties(scrollElement, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: rows.length * 100 },
    scrollTop: { configurable: true, writable: true, value: 1000 },
  });

  return renderHook(() =>
    useOutputVirtualization({
      applyScrollTargetRef: {
        current: () => ({ resolved: false, appliedDelta: 0 }),
      },
      getVirtualItemsRef: { current: () => [] },
      isProgrammaticScrollRef: { current: false },
      isMeasurementFlushInProgressRef: { current: false },
      lastScrollEventAtRef: { current: null },
      outputCollapsed: false,
      outputContentWidth: 360,
      outputFontSize: 13,
      outputOverscan: 2,
      outputOverscanRef: { current: 2 },
      outputRef: { current: scrollElement },
      outputVirtualizationRowThreshold: 0,
      rowRenderIdentity: "identity",
      rows,
      scrollSeekPlaceholderActive: false,
      scrollSeekRestoreRequestedAtRef: { current: null },
      scrollTargetRef: {
        current: { kind: "row", rowKey: "row-20" },
      },
    })
  );
}

// The anchor lock in useOutputScrollTarget owns scrollTop outright. The
// virtualizer's own compensation acts on a different clock — it writes
// `scrollTop += delta` from the ResizeObserver, while every row is still
// painted at its pre-commit `translateY` — so allowing it paints a viewport
// slide that the lock only undoes once the (450-650ms on a phone) commit
// lands. That round trip is the "jumps ~40px then jumps back" symptom.
describe("useOutputVirtualization scroll compensation", () => {
  it.each([
    ["a row above the anchor", 10],
    ["the anchored row itself", 20],
    ["a row below the anchor", 30],
  ])("refuses to compensate %s", (_label, itemIndex) => {
    const rows = makeRows(60);
    const { result } = renderVirtualization(rows);

    expect(
      result.current.rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange?.(
        { index: itemIndex, key: `row-${itemIndex}` } as never,
        80,
        result.current.rowVirtualizer as never
      )
    ).toBe(false);
  });

  it("refuses to compensate while the target is the bottom of the pane", () => {
    const rows = makeRows(60);
    const scrollElement = document.createElement("div");
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 6000 },
      scrollTop: { configurable: true, writable: true, value: 1000 },
    });

    const { result } = renderHook(() =>
      useOutputVirtualization({
        applyScrollTargetRef: {
          current: () => ({ resolved: false, appliedDelta: 0 }),
        },
        getVirtualItemsRef: { current: () => [] },
        isProgrammaticScrollRef: { current: false },
        isMeasurementFlushInProgressRef: { current: false },
        lastScrollEventAtRef: { current: null },
        outputCollapsed: false,
        outputContentWidth: 360,
        outputFontSize: 13,
        outputOverscan: 2,
        outputOverscanRef: { current: 2 },
        outputRef: { current: scrollElement },
        outputVirtualizationRowThreshold: 0,
        rowRenderIdentity: "identity",
        rows,
        scrollSeekPlaceholderActive: false,
        scrollSeekRestoreRequestedAtRef: { current: null },
        scrollTargetRef: { current: { kind: "bottom" } },
      })
    );

    expect(
      result.current.rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange?.(
        { index: 10, key: "row-10" } as never,
        80,
        result.current.rowVirtualizer as never
      )
    ).toBe(false);
  });
});
