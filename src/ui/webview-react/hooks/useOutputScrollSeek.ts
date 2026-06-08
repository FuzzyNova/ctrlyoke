import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  getWheelDeltaPixels,
} from "@components/layout/output-section/OutputScrollSeekPlaceholder";
import {
  logOutputProfilerEvent,
} from "@utils/outputPerformance";
import {
  LARGE_WORKFLOW_ROW_THRESHOLD,
  OUTPUT_USER_SCROLL_INPUT_GRACE_MS,
} from "@utils/outputScrollConstants";
import type { OutputRenderRow } from "@utils/outputRows";

const OUTPUT_VIRTUALIZER_OVERSCAN = 6;
const OUTPUT_ACTIVE_SCROLL_OVERSCAN = 2;
const OUTPUT_SCROLL_SEEK_RESTORE_OVERSCAN = 0;
const OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN = 3;
const OUTPUT_OVERSCAN_RESTORE_DELAY_MS = 250;
const OUTPUT_SCROLL_SEEK_CONTINUE_DELTA_PX = 16;
const OUTPUT_SCROLL_SEEK_SLOW_DELTA_PX = 48;
const OUTPUT_SCROLL_SEEK_SLOW_RESTORE_DELAY_MS = 80;
const OUTPUT_SCROLL_SEEK_MIN_DELTA_PX = 100;
const OUTPUT_SCROLL_SEEK_WHEEL_DELTA_PX = 16;
const OUTPUT_SCROLL_SEEK_TOUCH_DELTA_PX = 12;
const OUTPUT_SCROLL_SEEK_MIN_VELOCITY_PX_MS = 0.3;
const OUTPUT_SCROLL_SEEK_PAGE_FRACTION = 0.9;
const OUTPUT_SCROLL_SEEK_SETTLE_MS = 2000;
const OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN_DELAY_MS = 600;
const OUTPUT_SCROLL_SEEK_FULL_OVERSCAN_DELAY_MS = 1800;

interface UseOutputScrollSeekInput {
  applyScrollTargetRef: RefObject<(
    phase: string,
    options?: { force?: boolean }
  ) => { resolved: boolean; appliedDelta: number }>;
  commitScrollTargetFromViewportRef: RefObject<(reason: string) => void>;
  getRowEstimateStats: () => unknown[];
  getVirtualItemsRef: RefObject<() => readonly { index: number }[]>;
  hasOutput: boolean;
  isOutputVirtualizedRef: RefObject<boolean>;
  lastScrollEventAtRef: RefObject<number | null>;
  lastUserScrollInputAtRef: RefObject<number | null>;
  measurementVersion: number;
  rows: OutputRenderRow[];
  rowsRef: RefObject<readonly OutputRenderRow[]>;
  virtualRowsLength: number;
}

export interface OutputScrollSeekScrollMetrics {
  absScrollDeltaPx: number;
  isFastScroll: boolean;
  pageDeltaThresholdPx: number;
  rawFastScroll: boolean;
  scrollDeltaPx: number;
  scrollGapMs: number;
  scrollVelocityPxMs: number;
  suppressedFastScroll: boolean;
}

export function useOutputScrollSeek({
  applyScrollTargetRef,
  commitScrollTargetFromViewportRef,
  getRowEstimateStats,
  getVirtualItemsRef,
  hasOutput,
  isOutputVirtualizedRef,
  lastScrollEventAtRef,
  lastUserScrollInputAtRef,
  measurementVersion,
  rows,
  rowsRef,
  virtualRowsLength,
}: UseOutputScrollSeekInput) {
  const [outputOverscan, setOutputOverscan] = useState(
    OUTPUT_VIRTUALIZER_OVERSCAN
  );
  const [scrollSeekPlaceholderActive, setScrollSeekPlaceholderActiveState] =
    useState(false);
  const outputOverscanRef = useRef(outputOverscan);
  const scrollSeekStartedAtRef = useRef<number | null>(null);
  const scrollSeekRestoreRequestedAtRef = useRef<number | null>(null);
  const scrollSeekSettlingUntilRef = useRef<number | null>(null);
  const lastTouchYRef = useRef<number | null>(null);
  const scrollSeekPlaceholderRef = useRef(false);
  const scrollSeekEntryRenderedIndicesRef = useRef<ReadonlySet<number>>(
    new Set()
  );
  const overscanRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const fullOverscanRestoreTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const overscanRestoreRafRef = useRef<number | null>(null);

  useEffect(() => {
    outputOverscanRef.current = outputOverscan;
  }, [outputOverscan]);

  const setOutputOverscanMode = useCallback(
    (
      overscan: number,
      reason: "fast-scroll" | "idle",
      details?: Record<string, unknown>,
      activatePlaceholder?: boolean
    ) => {
      const overscanChanged = outputOverscanRef.current !== overscan;
      const newPlaceholder =
        activatePlaceholder === true
          ? true
          : activatePlaceholder === false
            ? false
            : scrollSeekPlaceholderRef.current;
      const placeholderChanged =
        newPlaceholder !== scrollSeekPlaceholderRef.current;

      if (!overscanChanged && !placeholderChanged) {
        return;
      }

      const now = performance.now();
      const wasPlaceholderActive = scrollSeekPlaceholderRef.current;

      if (overscanChanged) {
        outputOverscanRef.current = overscan;
        setOutputOverscan(overscan);
      }

      if (placeholderChanged) {
        scrollSeekPlaceholderRef.current = newPlaceholder;
        setScrollSeekPlaceholderActiveState(newPlaceholder);
        if (newPlaceholder && !wasPlaceholderActive) {
          scrollSeekStartedAtRef.current = now;
          scrollSeekRestoreRequestedAtRef.current = null;
        } else if (!newPlaceholder && wasPlaceholderActive) {
          scrollSeekRestoreRequestedAtRef.current = now;
        }
      }

      logOutputProfilerEvent("adaptiveOverscan", {
        overscan: outputOverscanRef.current,
        reason,
        placeholder: scrollSeekPlaceholderRef.current,
        scrollSeekDurationMs:
          placeholderChanged &&
          !newPlaceholder &&
          scrollSeekStartedAtRef.current != null
            ? now - scrollSeekStartedAtRef.current
            : undefined,
        ...details,
        rows: rowsRef.current.length,
      });
    },
    [rowsRef]
  );

  const scheduleOverscanRestore = useCallback(
    (delayMs?: number) => {
      if (overscanRestoreTimerRef.current !== null) {
        clearTimeout(overscanRestoreTimerRef.current);
      }
      if (fullOverscanRestoreTimerRef.current !== null) {
        clearTimeout(fullOverscanRestoreTimerRef.current);
        fullOverscanRestoreTimerRef.current = null;
      }
      if (overscanRestoreRafRef.current !== null) {
        cancelAnimationFrame(overscanRestoreRafRef.current);
        overscanRestoreRafRef.current = null;
      }

      overscanRestoreTimerRef.current = setTimeout(() => {
        overscanRestoreTimerRef.current = null;
        scrollSeekEntryRenderedIndicesRef.current = new Set();
        if (scrollSeekPlaceholderRef.current) {
          setOutputOverscanMode(
            OUTPUT_SCROLL_SEEK_RESTORE_OVERSCAN,
            "idle",
            { phase: "restore-visible-rows" },
            false
          );
        } else {
          setOutputOverscanMode(OUTPUT_VIRTUALIZER_OVERSCAN, "idle", {
            phase: "restore-full-overscan-direct",
          });
        }
      }, delayMs ?? OUTPUT_OVERSCAN_RESTORE_DELAY_MS);
    },
    [setOutputOverscanMode]
  );

  const enterFastScrollOverscan = useCallback(
    (details: Record<string, unknown>) => {
      if (!scrollSeekPlaceholderRef.current) {
        scrollSeekEntryRenderedIndicesRef.current = new Set(
          getVirtualItemsRef.current().map((vr) => vr.index)
        );
      }
      setOutputOverscanMode(
        OUTPUT_ACTIVE_SCROLL_OVERSCAN,
        "fast-scroll",
        details,
        true
      );
      scheduleOverscanRestore();
    },
    [getVirtualItemsRef, scheduleOverscanRestore, setOutputOverscanMode]
  );

  const updateScrollSeekForScroll = useCallback(
    (
      scrollElement: HTMLDivElement,
      previousScrollEventAt: number | null,
      previousScrollTop: number | null,
      now: number
    ): OutputScrollSeekScrollMetrics => {
      const scrollDeltaPx =
        previousScrollTop == null ? 0 : scrollElement.scrollTop - previousScrollTop;
      const absScrollDeltaPx = Math.abs(scrollDeltaPx);
      const scrollGapMs =
        previousScrollEventAt == null ? 0 : now - previousScrollEventAt;
      const scrollVelocityPxMs =
        scrollGapMs > 0 ? absScrollDeltaPx / scrollGapMs : 0;
      const pageDeltaThresholdPx =
        scrollElement.clientHeight * OUTPUT_SCROLL_SEEK_PAGE_FRACTION;
      const rawFastScroll =
        isOutputVirtualizedRef.current &&
        rowsRef.current.length >= LARGE_WORKFLOW_ROW_THRESHOLD &&
        (absScrollDeltaPx >= pageDeltaThresholdPx ||
          (absScrollDeltaPx >= OUTPUT_SCROLL_SEEK_MIN_DELTA_PX &&
            scrollVelocityPxMs >= OUTPUT_SCROLL_SEEK_MIN_VELOCITY_PX_MS));
      const isInScrollSeekSettleWindow =
        scrollSeekSettlingUntilRef.current != null &&
        now < scrollSeekSettlingUntilRef.current;
      const hasRecentUserScrollInput =
        lastUserScrollInputAtRef.current != null &&
        now - lastUserScrollInputAtRef.current <=
          OUTPUT_USER_SCROLL_INPUT_GRACE_MS;
      const suppressedFastScroll =
        rawFastScroll && isInScrollSeekSettleWindow && !hasRecentUserScrollInput;
      const isFastScroll = rawFastScroll && !suppressedFastScroll;
      if (isFastScroll) {
        enterFastScrollOverscan({
          scrollDeltaPx,
          scrollVelocityPxMs,
          scrollGapMs,
          pageDeltaThresholdPx,
        });
      } else if (suppressedFastScroll) {
        logOutputProfilerEvent("adaptiveOverscan", {
          overscan: outputOverscanRef.current,
          reason: "idle",
          phase: "suppressed-post-restore-scroll",
          scrollDeltaPx,
          scrollVelocityPxMs,
          scrollGapMs,
          pageDeltaThresholdPx,
          settleRemainingMs: (scrollSeekSettlingUntilRef.current ?? now) - now,
          rows: rowsRef.current.length,
        });
      } else if (
        outputOverscanRef.current === OUTPUT_ACTIVE_SCROLL_OVERSCAN &&
        absScrollDeltaPx >= OUTPUT_SCROLL_SEEK_CONTINUE_DELTA_PX
      ) {
        scheduleOverscanRestore(
          absScrollDeltaPx <= OUTPUT_SCROLL_SEEK_SLOW_DELTA_PX
            ? OUTPUT_SCROLL_SEEK_SLOW_RESTORE_DELAY_MS
            : OUTPUT_OVERSCAN_RESTORE_DELAY_MS
        );
      }

      return {
        absScrollDeltaPx,
        isFastScroll,
        pageDeltaThresholdPx,
        rawFastScroll,
        scrollDeltaPx,
        scrollGapMs,
        scrollVelocityPxMs,
        suppressedFastScroll,
      };
    },
    [
      enterFastScrollOverscan,
      isOutputVirtualizedRef,
      lastUserScrollInputAtRef,
      rowsRef,
      scheduleOverscanRestore,
    ]
  );

  const preArmScrollSeekForInput = useCallback(
    (
      scrollElement: HTMLDivElement,
      inputDeltaPx: number,
      thresholdPx: number,
      phase: "wheel-pre-scroll" | "touch-pre-scroll"
    ) => {
      const now = performance.now();
      lastUserScrollInputAtRef.current = now;
      const absInputDeltaPx = Math.abs(inputDeltaPx);

      if (
        isOutputVirtualizedRef.current &&
        rowsRef.current.length >= LARGE_WORKFLOW_ROW_THRESHOLD &&
        absInputDeltaPx >= thresholdPx
      ) {
        setOutputOverscanMode(OUTPUT_ACTIVE_SCROLL_OVERSCAN, "fast-scroll", {
          phase,
          inputDeltaPx,
          scrollDeltaPx: inputDeltaPx,
          scrollVelocityPxMs: undefined,
          scrollGapMs:
            lastScrollEventAtRef.current == null
              ? undefined
              : now - lastScrollEventAtRef.current,
          pageDeltaThresholdPx:
            scrollElement.clientHeight * OUTPUT_SCROLL_SEEK_PAGE_FRACTION,
        });
        scheduleOverscanRestore();
      }
    },
    [
      isOutputVirtualizedRef,
      lastScrollEventAtRef,
      lastUserScrollInputAtRef,
      rowsRef,
      scheduleOverscanRestore,
      setOutputOverscanMode,
    ]
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      preArmScrollSeekForInput(
        event.currentTarget,
        getWheelDeltaPixels(event),
        OUTPUT_SCROLL_SEEK_WHEEL_DELTA_PX,
        "wheel-pre-scroll"
      );
    },
    [preArmScrollSeekForInput]
  );

  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      lastUserScrollInputAtRef.current = performance.now();
      lastTouchYRef.current = event.touches[0]?.clientY ?? null;
    },
    [lastUserScrollInputAtRef]
  );

  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const currentY = event.touches[0]?.clientY;
      const previousY = lastTouchYRef.current;
      lastUserScrollInputAtRef.current = performance.now();
      if (currentY == null || previousY == null) {
        lastTouchYRef.current = currentY ?? null;
        return;
      }

      lastTouchYRef.current = currentY;
      preArmScrollSeekForInput(
        event.currentTarget,
        previousY - currentY,
        OUTPUT_SCROLL_SEEK_TOUCH_DELTA_PX,
        "touch-pre-scroll"
      );
    },
    [lastUserScrollInputAtRef, preArmScrollSeekForInput]
  );

  const handleTouchEnd = useCallback(() => {
    lastTouchYRef.current = null;
  }, []);

  useEffect(() => {
    if (scrollSeekPlaceholderActive || !hasOutput) {
      return;
    }

    const restoreRequestedAt = scrollSeekRestoreRequestedAtRef.current;
    const scrollSeekStartedAt = scrollSeekStartedAtRef.current;
    if (restoreRequestedAt == null) {
      return;
    }

    const now = performance.now();
    logOutputProfilerEvent("scrollSeekRowsVisible", {
      restoreToVisibleMs: now - restoreRequestedAt,
      scrollSeekTotalMs:
        scrollSeekStartedAt != null ? now - scrollSeekStartedAt : undefined,
      virtualRows: virtualRowsLength,
      overscan: outputOverscan,
      totalRows: rows.length,
      measurementVersion,
    });
    scrollSeekSettlingUntilRef.current = now + OUTPUT_SCROLL_SEEK_SETTLE_MS;
    commitScrollTargetFromViewportRef.current("scroll-seek-restore-commit");
    applyScrollTargetRef.current("scroll-seek-restore", { force: true });

    logOutputProfilerEvent("rowEstimateStats", {
      buckets: getRowEstimateStats(),
    });

    if (fullOverscanRestoreTimerRef.current !== null) {
      clearTimeout(fullOverscanRestoreTimerRef.current);
    }
    if (overscanRestoreRafRef.current !== null) {
      cancelAnimationFrame(overscanRestoreRafRef.current);
      overscanRestoreRafRef.current = null;
    }
    if (outputOverscanRef.current === OUTPUT_SCROLL_SEEK_RESTORE_OVERSCAN) {
      fullOverscanRestoreTimerRef.current = setTimeout(() => {
        fullOverscanRestoreTimerRef.current = null;
        let step = 1;
        const doNextOverscanStep = () => {
          if (overscanRestoreRafRef.current === null) return;
          if (step <= OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN) {
            setOutputOverscanMode(step, "idle", {
              phase: "restore-buffer-step",
              step,
            });
            step++;
            overscanRestoreRafRef.current = requestAnimationFrame(doNextOverscanStep);
          } else {
            overscanRestoreRafRef.current = null;
            fullOverscanRestoreTimerRef.current = setTimeout(() => {
              fullOverscanRestoreTimerRef.current = null;
              setOutputOverscanMode(OUTPUT_VIRTUALIZER_OVERSCAN, "idle", {
                phase: "restore-full-overscan",
              });
            }, OUTPUT_SCROLL_SEEK_FULL_OVERSCAN_DELAY_MS);
          }
        };
        overscanRestoreRafRef.current = requestAnimationFrame(doNextOverscanStep);
      }, OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN_DELAY_MS);
    }
    scrollSeekRestoreRequestedAtRef.current = null;
    scrollSeekStartedAtRef.current = null;
  }, [
    applyScrollTargetRef,
    commitScrollTargetFromViewportRef,
    getRowEstimateStats,
    hasOutput,
    measurementVersion,
    outputOverscan,
    rows.length,
    scrollSeekPlaceholderActive,
    setOutputOverscanMode,
    virtualRowsLength,
  ]);

  useEffect(
    () => () => {
      if (overscanRestoreTimerRef.current !== null) {
        clearTimeout(overscanRestoreTimerRef.current);
        overscanRestoreTimerRef.current = null;
      }
      if (fullOverscanRestoreTimerRef.current !== null) {
        clearTimeout(fullOverscanRestoreTimerRef.current);
        fullOverscanRestoreTimerRef.current = null;
      }
      if (overscanRestoreRafRef.current !== null) {
        cancelAnimationFrame(overscanRestoreRafRef.current);
        overscanRestoreRafRef.current = null;
      }
    },
    []
  );

  return {
    handleTouchEnd,
    handleTouchMove,
    handleTouchStart,
    handleWheel,
    outputOverscan,
    outputOverscanRef,
    renderedScrollSeekIndices: scrollSeekEntryRenderedIndicesRef.current,
    scheduleOverscanRestore,
    scrollSeekPlaceholderActive,
    scrollSeekPlaceholderRef,
    scrollSeekRestoreRequestedAtRef,
    scrollSeekSettlingUntilRef,
    updateScrollSeekForScroll,
  };
}
