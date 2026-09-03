import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOutputScrollTarget } from "@hooks/useOutputScrollTarget";
import type { OutputScrollTarget } from "@store/uiStore";
import {
  OUTPUT_ROW_KINDS,
  type OutputRowKind,
} from "@root/types/DashboardConstants";

function renderRowTargetHook(
  scrollElement: HTMLDivElement,
  rowTarget: OutputScrollTarget,
  lastProgrammaticScrollTopRef: { current: number | null } = { current: null }
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
      lastProgrammaticScrollTopRef,
      lastScrollEventAtRef: { current: null },
      lastScrollTopRef: { current: null },
      lastUserScrollInputAtRef: { current: null },
      layoutApplyTrigger: "initial",
      outputOverscanRef: { current: 6 },
      outputRef: { current: scrollElement },
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
        lastProgrammaticScrollTopRef: { current: null },
        lastScrollEventAtRef: { current: null },
        lastScrollTopRef: { current: null },
        lastUserScrollInputAtRef,
        layoutApplyTrigger: "initial",
        outputOverscanRef: { current: 6 },
        outputRef: { current: scrollElement },
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

  // A reflow-triggered muted attempt arriving partway through the grace window
  // must only wait out what remains of it, not a fresh full window from itself
  // — otherwise a reflow landing late in the window paints uncorrected for up
  // to 2x the grace period instead of being capped at it.
  it("retries a guarded apply after only the remaining grace window, not a fresh one", () => {
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
    // Scroll input "happened" 150ms before this render, so only 50ms of the
    // 200ms grace window remains.
    const lastUserScrollInputAtRef: { current: number | null } = {
      current: performance.now() - 150,
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
        lastProgrammaticScrollTopRef: { current: null },
        lastScrollEventAtRef: { current: null },
        lastScrollTopRef: { current: null },
        lastUserScrollInputAtRef,
        layoutApplyTrigger: "initial",
        outputOverscanRef: { current: 6 },
        outputRef: { current: scrollElement },
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
      result.current.applyScrollTarget("layout-effect");
    });
    expect(scrollTop).toBe(0);

    lastUserScrollInputAtRef.current = null;
    act(() => {
      // A fresh 200ms window from this attempt would still be muted here.
      vi.advanceTimersByTime(50);
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
        lastProgrammaticScrollTopRef: { current: null },
        lastScrollEventAtRef: { current: null },
        lastScrollTopRef: { current: null },
        lastUserScrollInputAtRef: { current: null },
        layoutApplyTrigger: "initial",
        outputOverscanRef: { current: 6 },
        outputRef: { current: scrollElement },
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

  // The scroll event this write provokes can outlive the isProgrammaticScroll
  // flag, and only the recorded position can identify it as ours once it does.
  // Without it, handleScroll re-anchors on the pane's own correction.
  it("records where it put the pane so the resulting scroll event is attributable", () => {
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
    rowElement.getBoundingClientRect = () => {
      const top = 553 - scrollTop;
      return { top, bottom: top + 50, height: 50 } as DOMRect;
    };

    const lastProgrammaticScrollTopRef: { current: number | null } = {
      current: null,
    };
    const { result } = renderRowTargetHook(
      scrollElement,
      { kind: "row", rowKey: "row-1", viewportOffsetPx: 100 },
      lastProgrammaticScrollTopRef
    );

    act(() => {
      result.current.applyScrollTarget("layout-effect", { force: true });
    });

    expect(scrollTop).toBe(433);
    expect(lastProgrammaticScrollTopRef.current).toBe(433);
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

  it("re-anchors a removed step row to its hidden placeholder and keeps bottom targets at bottom", () => {
    const scrollElement = document.createElement("div");
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, writable: true, value: 400 },
    });

    type TestRow = {
      key: string;
      rowKind: OutputRowKind;
      target: { kind: "queue"; index: number };
    };
    const oldRows: TestRow[] = [
      {
        key: "queue:0:anchor",
        rowKind: OUTPUT_ROW_KINDS.STEP_ANCHOR,
        target: { kind: "queue" as const, index: 0 },
      },
      {
        key: "queue:1:anchor",
        rowKind: OUTPUT_ROW_KINDS.STEP_ANCHOR,
        target: { kind: "queue" as const, index: 1 },
      },
      {
        key: "queue:1:content",
        rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
        target: { kind: "queue" as const, index: 1 },
      },
    ];
    const newRows: TestRow[] = [
      oldRows[0],
      oldRows[1],
      {
        key: "queue:1:hidden",
        rowKind: OUTPUT_ROW_KINDS.STEP_HIDDEN,
        target: { kind: "queue" as const, index: 1 },
      },
    ];
    const scrollTargetRef: { current: OutputScrollTarget } = {
      current: {
        kind: "row" as const,
        rowKey: "queue:1:content",
        viewportOffsetPx: 80,
      },
    };
    const rowsRef = { current: oldRows };
    const setOutputScrollTarget = vi.fn();

    const { rerender } = renderHook(
      ({
        rows,
        target,
      }: {
        rows: typeof oldRows;
        target: OutputScrollTarget;
      }) => {
        rowsRef.current = rows;
        scrollTargetRef.current = target;
        return useOutputScrollTarget({
          applyScrollTargetRef: {
            current: () => ({ resolved: false, appliedDelta: 0 }),
          },
          autoscrollEnabledRef: { current: false },
          bottomThresholdPx: 40,
          commitMaxRetries: 2,
          commitScrollTargetFromViewportRef: { current: () => undefined },
          defaultTarget: { kind: "bottom" },
          isProgrammaticScrollRef: { current: false },
          lastProgrammaticScrollTopRef: { current: null },
          lastScrollEventAtRef: { current: null },
          lastScrollTopRef: { current: null },
          lastUserScrollInputAtRef: { current: null },
          layoutApplyTrigger: "initial",
          outputOverscanRef: { current: 6 },
          outputRef: { current: scrollElement },
          pendingNavigationRef: { current: null },
          restoreTrigger: target.kind === "bottom" ? "bottom" : "initial",
          rowLayout: { rowStartsByKey: new Map(), totalSize: 1200 },
          rowVirtualizer: { measurementsCache: [] },
          rows,
          rowsRef,
          savedOutputScrollTarget: target,
          scrollTargetRef,
          setOutputScrollTarget,
          userScrollInputGraceMs: 200,
          workflowScrollTargetId: "workflow",
        });
      },
      {
        initialProps: {
          rows: oldRows,
          target: scrollTargetRef.current as OutputScrollTarget,
        },
      }
    );

    rerender({
      rows: newRows,
      target: {
        kind: "row",
        rowKey: "queue:1:content",
        viewportOffsetPx: 80,
      },
    });
    expect(scrollTargetRef.current).toEqual({
      kind: "row",
      rowKey: "queue:1:hidden",
      viewportOffsetPx: 80,
    });

    rerender({ rows: newRows, target: { kind: "bottom" } });
    expect(scrollTargetRef.current).toEqual({ kind: "bottom" });
  });
});
