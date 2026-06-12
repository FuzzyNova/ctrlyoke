import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOutputNavigation } from "@hooks/useOutputNavigation";
import { FINAL_STEP_PHASES } from "@/types/messages";

describe("useOutputNavigation", () => {
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

  beforeEach(() => {
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it("reveals the active find match instead of recentring the full row", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
    const scrollElement = document.createElement("div");
    const rowElement = document.createElement("div");
    const markElement = document.createElement("mark");

    rowElement.dataset.index = "0";
    rowElement.dataset.rowKey = "row-1";
    markElement.setAttribute("data-find-active", "true");
    rowElement.appendChild(markElement);
    scrollElement.appendChild(rowElement);
    document.body.appendChild(scrollElement);

    Object.defineProperty(scrollElement, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(scrollElement, "scrollHeight", {
      configurable: true,
      value: 4000,
    });
    let scrollTop = 0;
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    scrollElement.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 200,
        height: 200,
      }) as DOMRect;
    rowElement.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 2000,
        height: 2000,
      }) as DOMRect;
    markElement.getBoundingClientRect = () =>
      ({
        top: 1800,
        bottom: 1820,
        height: 20,
      }) as DOMRect;

    const autoscrollEnabledRef = { current: false };
    const isProgrammaticScrollRef = { current: false };
    const lastScrollTopRef = { current: null as number | null };
    const measurementVersionRef = { current: 0 };
    const navigationFrameRef = { current: null as number | null };
    const outputRef = { current: scrollElement };
    const pendingNavigationRef = { current: null };
    const postNavSettlingRef = { current: false };
    const postNavSettlingTimerRef = {
      current: null as ReturnType<typeof setTimeout> | null,
    };
    const rowVirtualizer = {
      scrollToIndex: vi.fn(),
      scrollToOffset: vi.fn(),
    };
    const setCurrentScrollTarget = vi.fn();

    const { result } = renderHook(() =>
      useOutputNavigation({
        autoscrollEnabledRef,
        finalizeSettlingDelayMs: 1000,
        firstRowIndexByTarget: new Map([[`${target.kind}:${target.index}`, 0]]),
        isOutputVirtualized: true,
        isProgrammaticScrollRef,
        lastScrollTopRef,
        maxAlignmentAttempts: 8,
        maxStabilizationMs: 1000,
        measurementVersion: 0,
        measurementVersionRef,
        navigationFrameRef,
        outputRef,
        pendingNavigationRef: pendingNavigationRef as never,
        postNavSettlingRef,
        postNavSettlingTimerRef,
        rowLayout: {
          rowSizesByKey: new Map([["row-1", 2000]]),
          rowStartsByIndex: [0],
          totalSize: 4000,
        },
        rowVirtualizer,
        rows: [{ key: "row-1", target }],
        setCurrentScrollTarget,
      })
    );

    act(() => {
      result.current.navigationController.scrollToRowIndex(0, {
        align: "center",
        revealActiveFindMatch: true,
      });
    });

    expect(scrollTop).toBe(1710);
    expect(rowVirtualizer.scrollToIndex).toHaveBeenCalledWith(0, {
      align: "center",
      behavior: "auto",
    });
    expect(rowVirtualizer.scrollToOffset).toHaveBeenCalledWith(1710, {
      behavior: "auto",
    });
    expect(setCurrentScrollTarget).toHaveBeenLastCalledWith(
      {
        kind: "row",
        rowKey: "row-1",
        viewportOffsetPx: 0,
      },
      "navigation-find-match"
    );
  });
});
