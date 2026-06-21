import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOutputScrollTarget } from "@hooks/useOutputScrollTarget";
import type { OutputScrollTarget } from "@store/uiStore";

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
});
