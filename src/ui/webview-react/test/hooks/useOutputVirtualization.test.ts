import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useOutputVirtualization } from "@hooks/useOutputVirtualization";
import type { OutputRenderRow } from "@utils/outputRows";
import { OUTPUT_ROW_KINDS } from "@root/types/DashboardConstants";

function makeRows(count: number): OutputRenderRow[] {
  return Array.from({ length: count }, (_value, index) => ({
    key: `row-${index}`,
    rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
    target: { kind: "queue" as const, index: 0 },
    text: `response ${index}`,
    rawTextOutput: true,
    animated: false,
    estimateSize: 100,
  }));
}

function renderVirtualization(
  rows: OutputRenderRow[],
  rowRenderIdentity = "identity"
) {
  const scrollElement = document.createElement("div");
  Object.defineProperties(scrollElement, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: rows.length * 100 },
    scrollTop: { configurable: true, writable: true, value: 1000 },
  });

  return renderHook(
    ({ identity }: { identity: string }) =>
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
        rowRenderIdentity: identity,
        rows,
        scrollSeekPlaceholderActive: false,
        scrollSeekRestoreRequestedAtRef: { current: null },
        scrollTargetRef: {
          current: { kind: "row", rowKey: "row-20", viewportOffsetPx: 200 },
        },
      }),
    { initialProps: { identity: rowRenderIdentity } }
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

  it("bulk remeasures when the row render identity changes", async () => {
    const rows = makeRows(60);
    const rendered = renderVirtualization(rows);
    const measure = vi.spyOn(rendered.result.current.rowVirtualizer, "measure");

    await waitFor(() => expect(measure).toHaveBeenCalled());
    const callsBeforeIdentityChange = measure.mock.calls.length;

    rendered.rerender({ identity: "identity:filter-1" });
    await waitFor(() =>
      expect(measure.mock.calls.length).toBeGreaterThan(
        callsBeforeIdentityChange
      )
    );
    rendered.unmount();
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
      rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
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

describe("useOutputVirtualization non-virtual row staging", () => {
  function renderNonVirtualStaging(initialRowCount: number) {
    const scrollElement = document.createElement("div");
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: initialRowCount * 100 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    return renderHook(
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
          // Kept well above the row count so the pane stays non-virtualized
          // and the staged-rendering path (rows.length >= 60) is exercised.
          outputVirtualizationRowThreshold: 1000,
          rowRenderIdentity: "live",
          rows,
          scrollSeekPlaceholderActive: false,
          scrollSeekRestoreRequestedAtRef: { current: null },
          scrollTargetRef: { current: { kind: "bottom" } },
        }),
      { initialProps: { rows: makeRows(initialRowCount) } }
    );
  }

  it("extends synchronously for a single streamed append once staging has caught up", async () => {
    const { result, rerender } = renderNonVirtualStaging(80);

    await waitFor(() => {
      expect(result.current.nonVirtualRows.length).toBe(80);
    });
    expect(result.current.isNonVirtualOutputStaging).toBe(false);

    // Regression: appending one row (a single streamed event) used to
    // re-enter the chunked catch-up flow and briefly re-report staging as
    // true, flashing the "Rendering output..." overlay even though nothing
    // needed to be staged.
    rerender({ rows: makeRows(81) });

    expect(result.current.nonVirtualRows.length).toBe(81);
    expect(result.current.isNonVirtualOutputStaging).toBe(false);
  });

  it("still stages a large initial batch of rows", () => {
    const { result } = renderNonVirtualStaging(80);

    expect(result.current.nonVirtualRows.length).toBeLessThan(80);
    expect(result.current.isNonVirtualOutputStaging).toBe(true);
  });
});

describe("useOutputVirtualization measurement convergence", () => {
  // The size the virtualizer actually positions the row at. `rowLayout` is
  // memoized on `measurementVersion`/`rows`, so it can lag a resize the hook
  // never announced — which is the very thing these tests are checking.
  function measuredSize(
    result: { current: ReturnType<typeof useOutputVirtualization> },
    rowKey: string
  ): number | undefined {
    // getTotalSize() first: it is what refreshes `measurementsCache`, exactly
    // as the hook's own rowLayout memo does.
    result.current.rowVirtualizer.getTotalSize();
    return result.current.rowVirtualizer.measurementsCache.find(
      (measurement) => String(measurement?.key) === rowKey
    )?.size;
  }

  interface FakeRowElement {
    element: HTMLDivElement;
    setHeight: (height: number) => void;
  }

  function appendFakeRow(
    scrollElement: HTMLDivElement,
    index: number,
    initialHeight: number
  ): FakeRowElement {
    let height = initialHeight;
    const element = document.createElement("div");
    element.dataset.index = String(index);
    element.dataset.rowKey = `row-${index}`;
    scrollElement.appendChild(element);
    Object.defineProperties(element, {
      offsetHeight: { configurable: true, get: () => height },
      scrollHeight: { configurable: true, get: () => height },
    });
    element.getBoundingClientRect = () =>
      ({
        bottom: height,
        height,
        left: 0,
        right: 360,
        top: 0,
        width: 360,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    return { element, setHeight: (next: number) => (height = next) };
  }

  function renderConvergence(initialRows: OutputRenderRow[]) {
    const scrollElement = document.createElement("div");
    document.body.appendChild(scrollElement);
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    // Every ref is hoisted out of the render callback on purpose. The hook
    // writes to isMeasurementFlushInProgressRef and reads it back on the
    // measurement path, and — more subtly — a fresh literal per render changes
    // `updateRowMeasurementCache`'s identity, which re-runs the live-row
    // remeasure layout effect on *every* render and quietly measures rows the
    // scenario is meant to leave unmeasured.
    const isMeasurementFlushInProgressRef = { current: false };
    const lastScrollEventAtRef: { current: number | null } = { current: null };
    const applyScrollTargetRef = {
      current: () => ({ resolved: false, appliedDelta: 0 }),
    };
    const getVirtualItemsRef = { current: () => [] };
    const isProgrammaticScrollRef = { current: false };
    const outputOverscanRef = { current: 2 };
    const outputRef = { current: scrollElement };
    const scrollSeekRestoreRequestedAtRef: { current: number | null } = {
      current: null,
    };
    const scrollTargetRef = { current: { kind: "bottom" as const } };

    const rendered = renderHook(
      ({ rows }: { rows: OutputRenderRow[] }) =>
        useOutputVirtualization({
          applyScrollTargetRef,
          getVirtualItemsRef,
          isProgrammaticScrollRef,
          isMeasurementFlushInProgressRef,
          lastScrollEventAtRef,
          outputCollapsed: false,
          outputContentWidth: 360,
          outputFontSize: 13,
          outputOverscan: 2,
          outputOverscanRef,
          outputRef,
          outputVirtualizationRowThreshold: 0,
          rowRenderIdentity: "live",
          rows,
          scrollSeekPlaceholderActive: false,
          scrollSeekRestoreRequestedAtRef,
          scrollTargetRef,
        }),
      { initialProps: { rows: initialRows } }
    );

    return { ...rendered, lastScrollEventAtRef, scrollElement };
  }

  // A row measuring 0 is a transient read — a collapsed pane zeroes every row,
  // and a freshly observed element can be measured before its first layout.
  // Handing that 0 to the virtualizer collapsed the row and let its neighbours
  // paint over it, which is one half of the "text hidden under the next event"
  // symptom.
  it("ignores a zero-height read instead of collapsing a measured row", async () => {
    const rows = makeRows(2);
    const { result, rerender, unmount, scrollElement } =
      renderConvergence(rows);
    const row = appendFakeRow(scrollElement, 0, 180);

    act(() => {
      result.current.measureRowElement(row.element);
    });
    await waitFor(() => {
      expect(measuredSize(result, "row-0")).toBe(180);
    });

    // Synchronous on purpose: the layout-effect remeasure runs inside
    // `rerender`, and a later bulk remeasure would paper over the bad size by
    // falling back to the estimate cache. The claim is that the zero read never
    // lands in the first place.
    row.setHeight(0);
    rerender({ rows: makeRows(2) });

    expect(measuredSize(result, "row-0")).toBe(180);

    unmount();
    scrollElement.remove();
  });

  // The deferral that keeps a measurement from reflowing the pane mid-scroll is
  // only safe if the flush that drains it always lands. It used to clear the
  // pending map after iterating it, so a row re-queued by a flush that ran
  // inside the scroll grace was dropped for good — and with the DOM size
  // unchanged no ResizeObserver entry was ever coming to offer it again.
  it("applies deferred measurements even when the flush lands inside the scroll grace", () => {
    const rows = makeRows(2);
    const { result, unmount, lastScrollEventAtRef, scrollElement } =
      renderConvergence(rows);
    const row = appendFakeRow(scrollElement, 0, 180);

    lastScrollEventAtRef.current = performance.now();
    act(() => {
      result.current.measureRowElement(row.element);
    });
    expect(result.current.hasPendingMeasurements()).toBe(true);
    expect(measuredSize(result, "row-0")).not.toBe(180);

    // The flush runs while the pane still counts as scrolling, and must settle
    // the row then and there rather than re-queueing it.
    lastScrollEventAtRef.current = performance.now();
    act(() => {
      result.current.flushPendingScrollMeasurements();
    });

    expect(measuredSize(result, "row-0")).toBe(180);
    expect(result.current.hasPendingMeasurements()).toBe(false);

    unmount();
    scrollElement.remove();
  });

  // A row that mounted mid-scroll can end up rendered but never measured at
  // all. The flush is the pane's settle point, so it also sweeps the mounted
  // rows that still carry an estimate.
  it("measures mounted rows that never had a measurement applied", async () => {
    const rows = makeRows(2);
    const { result, unmount, lastScrollEventAtRef, scrollElement } =
      renderConvergence(rows);
    const pendingRow = appendFakeRow(scrollElement, 0, 180);
    // Zero at registration stands in for "observed before its first layout":
    // the read is discarded, so this row stays mounted carrying only an
    // estimate, with nothing queued that would ever revisit it.
    const neverMeasured = appendFakeRow(scrollElement, 1, 0);

    act(() => {
      result.current.measureRowElement(neverMeasured.element);
    });
    neverMeasured.setHeight(240);
    expect(measuredSize(result, "row-1")).not.toBe(240);

    // A recent scroll both defers row-0's measurement into the pending map and
    // keeps the post-load remeasure passes out of the way, so the flush is the
    // only thing that can settle either row.
    lastScrollEventAtRef.current = performance.now();
    act(() => {
      result.current.measureRowElement(pendingRow.element);
    });
    expect(result.current.hasPendingMeasurements()).toBe(true);

    act(() => {
      result.current.flushPendingScrollMeasurements();
    });

    expect(measuredSize(result, "row-0")).toBe(180);
    expect(measuredSize(result, "row-1")).toBe(240);

    unmount();
    scrollElement.remove();
  });
});
