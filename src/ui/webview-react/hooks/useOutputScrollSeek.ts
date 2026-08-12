import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import { getWheelDeltaPixels } from "@components/layout/output-section/OutputScrollSeekPlaceholder";
import { clamp } from "@utils/number";
import { logProfilerEvent } from "@utils/performanceProfiler";
import {
  LARGE_WORKFLOW_ROW_THRESHOLD,
  OUTPUT_USER_SCROLL_INPUT_GRACE_MS,
} from "@utils/outputScrollConstants";
import type { OutputRenderRow } from "@utils/outputRows";

/**
 * Idle overscan bounds. The effective value is derived per pane from
 * `getIdleOverscan` so the off-screen buffer is sized in *viewports*, not in
 * rows: a flat 6 meant three-plus screens of buffer on a phone (tall wrapped
 * rows, short pane), and mounting/measuring that many off-screen rows cost
 * 700-1800ms commits whose height corrections landed as visible jumps seconds
 * after the user stopped scrolling.
 */
const OUTPUT_MIN_IDLE_OVERSCAN = 2;
const OUTPUT_MAX_IDLE_OVERSCAN = 6;
const OUTPUT_ACTIVE_SCROLL_OVERSCAN = 2;
const OUTPUT_SCROLL_SEEK_RESTORE_OVERSCAN = 0;
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

/**
 * Size the idle off-screen buffer at roughly one viewport in each direction.
 *
 * `scrollHeight` is the virtual canvas, so `scrollHeight / rowCount` is the
 * mean row height across the whole workflow — including the rows that are not
 * mounted, which is exactly the population being buffered.
 */
export function getIdleOverscanForViewport(
  viewportHeightPx: number,
  contentHeightPx: number,
  rowCount: number
): number {
  const averageRowHeightPx = rowCount > 0 ? contentHeightPx / rowCount : 0;
  if (!(averageRowHeightPx > 0) || !(viewportHeightPx > 0)) {
    return OUTPUT_MAX_IDLE_OVERSCAN;
  }
  return clamp(
    Math.ceil(viewportHeightPx / averageRowHeightPx),
    OUTPUT_MIN_IDLE_OVERSCAN,
    OUTPUT_MAX_IDLE_OVERSCAN
  );
}

interface UseOutputScrollSeekInput {
  applyScrollTargetRef: RefObject<
    (
      phase: string,
      options?: { force?: boolean }
    ) => { resolved: boolean; appliedDelta: number }
  >;
  commitScrollTargetFromViewportRef: RefObject<(reason: string) => void>;
  flushPendingScrollMeasurementsRef: RefObject<() => void>;
  getRowEstimateStats: () => unknown[];
  getVirtualItemsRef: RefObject<() => readonly { index: number }[]>;
  hasOutput: boolean;
  isOutputVirtualizedRef: RefObject<boolean>;
  lastScrollEventAtRef: RefObject<number | null>;
  lastUserScrollInputAtRef: RefObject<number | null>;
  measurementVersion: number;
  outputRef: RefObject<HTMLDivElement | null>;
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
  flushPendingScrollMeasurementsRef,
  getRowEstimateStats,
  getVirtualItemsRef,
  hasOutput,
  isOutputVirtualizedRef,
  lastScrollEventAtRef,
  lastUserScrollInputAtRef,
  measurementVersion,
  outputRef,
  rows,
  rowsRef,
  virtualRowsLength,
}: UseOutputScrollSeekInput) {
  const [outputOverscan, setOutputOverscan] = useState(
    OUTPUT_MAX_IDLE_OVERSCAN
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

  const getIdleOverscan = useCallback(() => {
    const scrollElement = outputRef.current;
    if (!scrollElement) {
      return OUTPUT_MAX_IDLE_OVERSCAN;
    }
    return getIdleOverscanForViewport(
      scrollElement.clientHeight,
      scrollElement.scrollHeight,
      rowsRef.current.length
    );
  }, [outputRef, rowsRef]);

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

      logProfilerEvent("adaptiveOverscan", {
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
        const now = performance.now();
        const lastScrollActivityAt = Math.max(
          lastScrollEventAtRef.current ?? 0,
          lastUserScrollInputAtRef.current ?? 0
        );
        const scrollIdleMs = now - lastScrollActivityAt;
        if (scrollIdleMs < OUTPUT_USER_SCROLL_INPUT_GRACE_MS) {
          scheduleOverscanRestore(
            OUTPUT_USER_SCROLL_INPUT_GRACE_MS - scrollIdleMs
          );
          return;
        }

        scrollSeekEntryRenderedIndicesRef.current = new Set();
        if (scrollSeekPlaceholderRef.current) {
          setOutputOverscanMode(
            OUTPUT_SCROLL_SEEK_RESTORE_OVERSCAN,
            "idle",
            { phase: "restore-visible-rows" },
            false
          );
        } else {
          setOutputOverscanMode(getIdleOverscan(), "idle", {
            phase: "restore-full-overscan-direct",
          });
        }
      }, delayMs ?? OUTPUT_OVERSCAN_RESTORE_DELAY_MS);
    },
    [
      getIdleOverscan,
      lastScrollEventAtRef,
      lastUserScrollInputAtRef,
      setOutputOverscanMode,
    ]
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
        previousScrollTop == null
          ? 0
          : scrollElement.scrollTop - previousScrollTop;
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
        rawFastScroll &&
        isInScrollSeekSettleWindow &&
        !hasRecentUserScrollInput;
      const isFastScroll = rawFastScroll && !suppressedFastScroll;
      if (isFastScroll) {
        enterFastScrollOverscan({
          scrollDeltaPx,
          scrollVelocityPxMs,
          scrollGapMs,
          pageDeltaThresholdPx,
        });
      } else if (suppressedFastScroll) {
        logProfilerEvent("adaptiveOverscan", {
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

  // useLayoutEffect (not useEffect): the placeholder→real-row swap and its
  // accumulated estimate catch-up (often several thousand px when many rows were
  // fast-scrolled past) must be reconciled BEFORE the browser paints, otherwise
  // the user sees the uncorrected layout for a frame — the "flash after scroll
  // stops".
  useLayoutEffect(() => {
    if (scrollSeekPlaceholderActive || !hasOutput) {
      return;
    }

    const restoreRequestedAt = scrollSeekRestoreRequestedAtRef.current;
    const scrollSeekStartedAt = scrollSeekStartedAtRef.current;
    if (restoreRequestedAt == null) {
      return;
    }

    const now = performance.now();
    logProfilerEvent("scrollSeekRowsVisible", {
      restoreToVisibleMs: now - restoreRequestedAt,
      scrollSeekTotalMs:
        scrollSeekStartedAt != null ? now - scrollSeekStartedAt : undefined,
      virtualRows: virtualRowsLength,
      overscan: outputOverscan,
      totalRows: rows.length,
      measurementVersion,
    });
    scrollSeekSettlingUntilRef.current = now + OUTPUT_SCROLL_SEEK_SETTLE_MS;
    // Capture the anchor the user is currently looking at (pre-flush DOM), then
    // drain all deferred measurements so the layout model is complete in one
    // shot, then restore that anchor against the settled model. Doing the flush
    // here — between capture and apply — collapses what was previously a
    // commit → late-flush → re-correct sequence (the double -7145/-7590 applies
    // in the logs) into a single pre-paint correction.
    commitScrollTargetFromViewportRef.current("scroll-seek-restore-commit");
    flushPendingScrollMeasurementsRef.current();
    applyScrollTargetRef.current("scroll-seek-restore");

    logProfilerEvent("rowEstimateStats", {
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
        // Walk up to the idle target one row per frame and stop there. This
        // used to climb to a fixed 3, wait another 1.8s, then jump to 6 — so
        // off-screen rows kept mounting, measuring, and nudging the anchor for
        // ~4s after the user's finger left the screen, which reads as an
        // unprovoked jump rather than part of the settle. Every wave is a
        // separate React commit, so pacing by frame still keeps them apart.
        const idleOverscan = getIdleOverscan();
        let step = 1;
        const doNextOverscanStep = () => {
          if (overscanRestoreRafRef.current === null) return;
          if (step < idleOverscan) {
            setOutputOverscanMode(step, "idle", {
              phase: "restore-buffer-step",
              step,
            });
            step++;
            overscanRestoreRafRef.current =
              requestAnimationFrame(doNextOverscanStep);
          } else {
            overscanRestoreRafRef.current = null;
            setOutputOverscanMode(idleOverscan, "idle", {
              phase: "restore-full-overscan",
              idleOverscan,
            });
          }
        };
        overscanRestoreRafRef.current =
          requestAnimationFrame(doNextOverscanStep);
      }, OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN_DELAY_MS);
    }
    scrollSeekRestoreRequestedAtRef.current = null;
    scrollSeekStartedAtRef.current = null;
  }, [
    applyScrollTargetRef,
    commitScrollTargetFromViewportRef,
    flushPendingScrollMeasurementsRef,
    getIdleOverscan,
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
