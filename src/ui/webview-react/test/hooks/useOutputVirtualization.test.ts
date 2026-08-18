import { act, renderHook, waitFor } from "@testing-library/react";
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
        current: { kind: "row", rowKey: "row-20", viewportOffsetPx: 200 },
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

describe("useOutputVirtualization live row measurement", () => {
  it("remeasures an already-mounted row when its live render model changes", async () => {
    let measuredHeight = 100;
    const scrollElement = document.createElement("div");
    const rowElement = document.createElement("div");
    rowElement.dataset.index = "0";
    rowElement.dataset.rowKey = "row-0";
    scrollElement.appendChild(rowElement);
    document.body.appendChild(scrollElement);

    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    Object.defineProperties(rowElement, {
      offsetHeight: {
        configurable: true,
        get: () => measuredHeight,
      },
      scrollHeight: {
        configurable: true,
        get: () => measuredHeight,
      },
    });
    rowElement.getBoundingClientRect = () =>
      ({
        bottom: measuredHeight,
        height: measuredHeight,
        left: 0,
        right: 360,
        top: 0,
        width: 360,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const initialRow = {
      key: "row-0",
      rowKind: "plain-response",
      target: { kind: "queue", index: 0 },
      text: "initial response",
      rawTextOutput: true,
      animated: false,
      estimateSize: 100,
    } satisfies OutputRenderRow;
    const initialRows: OutputRenderRow[] = [initialRow];
    const { result, rerender, unmount } = renderHook(
      ({ rows }: { rows: OutputRenderRow[] }) =>
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
          rowRenderIdentity: "live",
          rows,
          scrollSeekPlaceholderActive: false,
          scrollSeekRestoreRequestedAtRef: { current: null },
          scrollTargetRef: { current: { kind: "bottom" } },
        }),
      { initialProps: { rows: initialRows } }
    );

    act(() => {
      result.current.measureRowElement(rowElement);
    });

    measuredHeight = 180;
    rerender({
      rows: [{ ...initialRow, text: "updated live response" }],
    });

    await waitFor(() => {
      expect(result.current.rowLayout.rowSizesByKey.get("row-0")).toBe(180);
    });

    unmount();
    scrollElement.remove();
  });
});
