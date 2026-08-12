import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOutputScrollTarget } from "@hooks/useOutputScrollTarget";
import type { OutputScrollTarget } from "@store/uiStore";

function renderRowTargetHook(
  scrollElement: HTMLDivElement,
  rowTarget: OutputScrollTarget
) {
  return renderHook(() =>
    useOutputScrollTarget({
      applyScrollTargetRef: {
        current: () => ({ resolved: false, appliedDelta: 0 }),
      },
      autoscrollEnabledRef: { current: false },
      bottomThresholdPx: 40,
      commitMaxRetries: 2,
      commitScrollTargetFromViewportRef: { current: () => undefined },
      defaultTarget: { kind: "bottom" },
      isProgrammaticScrollRef: { current: false },
      lastScrollEventAtRef: { current: null },
      lastScrollTopRef: { current: null },
      lastUserScrollInputAtRef: { current: null },
      layoutApplyTrigger: "initial",
      outputOverscanRef: { current: 6 },
      outputRef: { current: scrollElement },
      pendingDirectScrollWriteRef: { current: false },
      pendingNavigationRef: { current: null },
      restoreTrigger: "workflow",
      rowLayout: {
        rowStartsByKey: new Map([["row-1", 500]]),
        totalSize: 1200,
      },
      rowsRef: { current: [{ key: "row-1" }] },
      rowVirtualizer: {
        measurementsCache: [{ key: "row-1", start: 500 }],
      },
      savedOutputScrollTarget: rowTarget,
      scrollTargetRef: { current: rowTarget },
      setOutputScrollTarget: vi.fn(),
      userScrollInputGraceMs: 200,
      workflowScrollTargetId: "workflow",
    })
  );
}

describe("useOutputScrollTarget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers a guarded target apply until user scrolling is idle", () => {
    vi.useFakeTimers();
    const scrollElement = document.createElement("div");
    let scrollTop = 0;
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });

    const defaultTarget: OutputScrollTarget = { kind: "bottom" };
    const applyScrollTargetRef = {
      current: () => ({ resolved: false, appliedDelta: 0 }),
    };
    const lastUserScrollInputAtRef: { current: number | null } = {
      current: performance.now(),
    };

    const { result } = renderHook(() =>
      useOutputScrollTarget({
        applyScrollTargetRef,
        autoscrollEnabledRef: { current: true },
        bottomThresholdPx: 24,
        commitMaxRetries: 2,
        commitScrollTargetFromViewportRef: { current: () => undefined },
        defaultTarget,
        isProgrammaticScrollRef: { current: false },
        lastScrollEventAtRef: { current: null },
        lastScrollTopRef: { current: null },
        lastUserScrollInputAtRef,
        layoutApplyTrigger: "initial",
        outputOverscanRef: { current: 6 },
        outputRef: { current: scrollElement },
        pendingDirectScrollWriteRef: { current: false },
        pendingNavigationRef: { current: null },
        restoreTrigger: "workflow",
        rowLayout: { rowStartsByKey: new Map(), totalSize: 1000 },
        rowsRef: { current: [{ key: "row-1" }] },
        rowVirtualizer: { measurementsCache: [] },
        savedOutputScrollTarget: defaultTarget,
        scrollTargetRef: { current: defaultTarget },
        setOutputScrollTarget: vi.fn(),
        userScrollInputGraceMs: 200,
        workflowScrollTargetId: "workflow",
      })
    );

    act(() => {
      result.current.applyScrollTarget("auto-scroll");
    });
    expect(scrollTop).toBe(0);

    lastUserScrollInputAtRef.current = null;
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(scrollTop).toBe(800);
  });

  // Guards the sticky-bottom latch: while auto-scroll is armed, a viewport that
  // streaming output has grown past must still commit the bottom target.
  // Committing a row anchor here would disarm auto-scroll for the rest of the
  // run (setCurrentScrollTarget derives the armed flag from the target kind).
  it("commits the bottom target while auto-scroll is armed, even far from the bottom", () => {
    const scrollElement = document.createElement("div");
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 5000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    const defaultTarget: OutputScrollTarget = { kind: "bottom" };
    const setOutputScrollTarget = vi.fn();
    const autoscrollEnabledRef = { current: true };

    const { result } = renderHook(() =>
      useOutputScrollTarget({
        applyScrollTargetRef: {
          current: () => ({ resolved: false, appliedDelta: 0 }),
        },
        autoscrollEnabledRef,
        bottomThresholdPx: 40,
        commitMaxRetries: 2,
        commitScrollTargetFromViewportRef: { current: () => undefined },
        defaultTarget,
        isProgrammaticScrollRef: { current: false },
        lastScrollEventAtRef: { current: null },
        lastScrollTopRef: { current: null },
        lastUserScrollInputAtRef: { current: null },
        layoutApplyTrigger: "initial",
        outputOverscanRef: { current: 6 },
        outputRef: { current: scrollElement },
        pendingDirectScrollWriteRef: { current: false },
        pendingNavigationRef: { current: null },
        restoreTrigger: "workflow",
        rowLayout: { rowStartsByKey: new Map(), totalSize: 5000 },
        rowsRef: { current: [{ key: "row-1" }] },
        rowVirtualizer: { measurementsCache: [] },
        savedOutputScrollTarget: defaultTarget,
        scrollTargetRef: { current: defaultTarget },
        setOutputScrollTarget,
        userScrollInputGraceMs: 200,
        workflowScrollTargetId: "workflow",
      })
    );

    act(() => {
      result.current.commitScrollTargetFromViewport("streaming-growth");
    });

    expect(setOutputScrollTarget).toHaveBeenCalledWith("workflow", {
      kind: "bottom",
    });
    expect(autoscrollEnabledRef.current).toBe(true);
  });

  it("restores a rendered row from DOM geometry without dropping the run-banner offset", () => {
    const scrollElement = document.createElement("div");
    const rowElement = document.createElement("div");
    rowElement.dataset.rowKey = "row-1";
    scrollElement.append(rowElement);

    let scrollTop = 400;
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    scrollElement.getBoundingClientRect = () =>
      ({ top: 20, bottom: 220, height: 200 }) as DOMRect;
    // At scrollTop 400, virtual start 500 plus a 33px run banner paints the
    // row at viewport offset 133. Restoring offset 100 must therefore move to
    // 433, not the banner-blind estimate 500 - 100 = 400.
    rowElement.getBoundingClientRect = () => {
      const top = 553 - scrollTop;
      return { top, bottom: top + 50, height: 50 } as DOMRect;
    };

    const rowTarget: OutputScrollTarget = {
      kind: "row",
      rowKey: "row-1",
      viewportOffsetPx: 100,
    };
    const { result } = renderRowTargetHook(scrollElement, rowTarget);

    act(() => {
      result.current.applyScrollTarget("layout-effect", { force: true });
    });

    expect(scrollTop).toBe(433);
  });

  it("includes the row-container offset when the target row is not rendered yet", () => {
    const scrollElement = document.createElement("div");
    const rowContainer = document.createElement("div");
    rowContainer.dataset.outputRowContainer = "";
    scrollElement.append(rowContainer);

    let scrollTop = 400;
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    scrollElement.getBoundingClientRect = () =>
      ({ top: 20, bottom: 220, height: 200 }) as DOMRect;
    rowContainer.getBoundingClientRect = () => {
      const top = 53 - scrollTop;
      return { top, bottom: top + 1200, height: 1200 } as DOMRect;
    };

    const rowTarget: OutputScrollTarget = {
      kind: "row",
      rowKey: "row-1",
      viewportOffsetPx: 100,
    };
    const { result } = renderRowTargetHook(scrollElement, rowTarget);

    act(() => {
      result.current.applyScrollTarget("workflow-target-restore", {
        force: true,
      });
    });

    expect(scrollTop).toBe(433);
  });
});
