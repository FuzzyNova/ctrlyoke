import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOutputNavigation } from "@hooks/useOutputNavigation";
import { FINAL_STEP_PHASES } from "@/types/messages";
import { OUTPUT_ROW_KINDS } from "@root/types/DashboardConstants";

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
        rows: [
          {
            key: "row-1",
            rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
            target,
            estimateSize: 80,
          },
        ],
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
        viewportOffsetPx: -1710,
      },
      "navigation-find-match"
    );
  });

  it("uses auto behavior for non-virtual navigation even when smooth is requested", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
    const scrollElement = document.createElement("div");
    const rowElement = document.createElement("div");

    rowElement.dataset.index = "0";
    rowElement.dataset.rowKey = "row-1";
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
    let scrollTop = 1200;
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
        top: 40,
        bottom: 120,
        height: 80,
      }) as DOMRect;
    scrollElement.scrollTo = vi.fn(
      ({ top }: { top?: number; behavior?: ScrollBehavior }) => {
        if (typeof top === "number") {
          scrollTop = top;
        }
      }
    ) as typeof scrollElement.scrollTo;

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
        isOutputVirtualized: false,
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
          rowSizesByKey: new Map([["row-1", 80]]),
          rowStartsByIndex: [100],
          totalSize: 4000,
        },
        rowVirtualizer,
        rows: [
          {
            key: "row-1",
            rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
            target,
            estimateSize: 80,
          },
        ],
        setCurrentScrollTarget,
      })
    );

    act(() => {
      result.current.navigationController.scrollToTarget(target, {
        align: "start",
        behavior: "smooth",
      });
    });

    expect(scrollElement.scrollTo).toHaveBeenCalledWith({
      top: 1240,
      behavior: "auto",
    });
    expect(scrollTop).toBe(1240);
  });

  it("navigates hidden targets to their placeholder instead of their anchor", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 0 } as const;
    const scrollElement = document.createElement("div");
    const outputRef = { current: scrollElement };
    const rowVirtualizer = {
      scrollToIndex: vi.fn(),
      scrollToOffset: vi.fn(),
    };
    const autoscrollEnabledRef = { current: true };
    const isProgrammaticScrollRef = { current: false };
    const lastScrollTopRef = { current: null as number | null };
    const measurementVersionRef = { current: 0 };
    const navigationFrameRef = { current: null as number | null };
    const pendingNavigationRef = { current: null };
    const postNavSettlingRef = { current: false };
    const postNavSettlingTimerRef = {
      current: null as ReturnType<typeof setTimeout> | null,
    };

    const { result } = renderHook(() =>
      useOutputNavigation({
        autoscrollEnabledRef,
        finalizeSettlingDelayMs: 1000,
        firstRowIndexByTarget: new Map([["queue:0", 0]]),
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
          rowSizesByKey: new Map(),
          rowStartsByIndex: [0, 1],
          totalSize: 100,
        },
        rowVirtualizer,
        rows: [
          {
            key: "queue:0:anchor",
            rowKind: OUTPUT_ROW_KINDS.STEP_ANCHOR,
            target,
            estimateSize: 1,
          },
          {
            key: "queue:0:hidden",
            rowKind: OUTPUT_ROW_KINDS.STEP_HIDDEN,
            target,
            estimateSize: 48,
          },
        ],
        setCurrentScrollTarget: vi.fn(),
      })
    );

    act(() => {
      result.current.navigationController.scrollToTarget(target, {
        behavior: "smooth",
        align: "start",
      });
    });

    expect(rowVirtualizer.scrollToIndex).toHaveBeenCalledWith(1, {
      align: "start",
      behavior: "auto",
    });
  });

  it("uses the one-per-target anchor when activity rows are interleaved", () => {
    const target = { kind: FINAL_STEP_PHASES.QUEUE, index: 1 } as const;
    const scrollElement = document.createElement("div");
    const outputRef = { current: scrollElement };
    const rowVirtualizer = {
      scrollToIndex: vi.fn(),
      scrollToOffset: vi.fn(),
    };
    const pendingNavigationRef = { current: null };

    const { result } = renderHook(() =>
      useOutputNavigation({
        anchorRowIndexByTarget: new Map([["queue:1", 0]]),
        autoscrollEnabledRef: { current: false },
        finalizeSettlingDelayMs: 1000,
        firstRowIndexByTarget: new Map([["queue:1", 2]]),
        isOutputVirtualized: true,
        isProgrammaticScrollRef: { current: false },
        lastScrollTopRef: { current: null },
        maxAlignmentAttempts: 8,
        maxStabilizationMs: 1000,
        measurementVersion: 0,
        measurementVersionRef: { current: 0 },
        navigationFrameRef: { current: null },
        outputRef,
        pendingNavigationRef: pendingNavigationRef as never,
        postNavSettlingRef: { current: false },
        postNavSettlingTimerRef: { current: null },
        rowLayout: {
          rowSizesByKey: new Map(),
          rowStartsByIndex: [0, 40, 80],
          totalSize: 120,
        },
        rowVirtualizer,
        rows: [
          {
            key: "queue:1:anchor",
            rowKind: OUTPUT_ROW_KINDS.STEP_ANCHOR,
            target,
            estimateSize: 1,
          },
          {
            key: "queue:0:activity",
            rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
            target: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
            estimateSize: 40,
          },
          {
            key: "queue:1:latest-activity",
            rowKind: OUTPUT_ROW_KINDS.PLAIN_RESPONSE,
            target,
            estimateSize: 40,
          },
        ],
        setCurrentScrollTarget: vi.fn(),
      })
    );

    act(() => {
      result.current.navigationController.scrollToTarget(target, {
        behavior: "smooth",
        align: "start",
      });
    });

    expect(rowVirtualizer.scrollToIndex).toHaveBeenCalledWith(0, {
      align: "start",
      behavior: "auto",
    });
  });
});
