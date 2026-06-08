import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { OutputScrollTarget } from "@store/uiStore";
import { captureViewportRowAnchor } from "@utils/outputDom";
import { clamp } from "@utils/number";
import {
  isProfilingEnabled,
  logProfilerEvent,
} from "@utils/performanceProfiler";

interface OutputRowLayoutModel {
  rowStartsByKey: Map<string, number>;
  totalSize: number;
}

interface RowMeasurement {
  key: string | number | bigint;
  start: number;
}

interface RowVirtualizerLike {
  measurementsCache: Array<RowMeasurement | null | undefined>;
}

interface UseOutputScrollTargetInput {
  applyScrollTargetRef: RefObject<
    (phase: string, options?: { force?: boolean }) => {
      resolved: boolean;
      appliedDelta: number;
    }
  >;
  autoscrollEnabledRef: RefObject<boolean>;
  commitScrollTargetFromViewportRef: RefObject<(reason: string) => void>;
  defaultTarget: OutputScrollTarget;
  isProgrammaticScrollRef: RefObject<boolean>;
  lastScrollEventAtRef: RefObject<number | null>;
  lastScrollTopRef: RefObject<number | null>;
  lastUserScrollInputAtRef: RefObject<number | null>;
  outputOverscanRef: RefObject<number>;
  outputRef: RefObject<HTMLDivElement | null>;
  pendingNavigationRef: RefObject<unknown | null>;
  rowLayout: OutputRowLayoutModel;
  rowVirtualizer: RowVirtualizerLike;
  rowsRef: RefObject<readonly { key: string }[]>;
  restoreTrigger: string;
  savedOutputScrollTarget: OutputScrollTarget | undefined;
  scrollTargetRef: RefObject<OutputScrollTarget>;
  setOutputScrollTarget: (
    workflowId: string,
    target: OutputScrollTarget
  ) => void;
  workflowScrollTargetId: string;
  bottomThresholdPx: number;
  commitMaxRetries: number;
  layoutApplyTrigger: string;
  userScrollInputGraceMs: number;
}

export function useOutputScrollTarget({
  applyScrollTargetRef,
  autoscrollEnabledRef,
  commitScrollTargetFromViewportRef,
  defaultTarget,
  isProgrammaticScrollRef,
  lastScrollEventAtRef,
  lastScrollTopRef,
  lastUserScrollInputAtRef,
  outputOverscanRef,
  outputRef,
  pendingNavigationRef,
  rowLayout,
  rowVirtualizer,
  rowsRef,
  restoreTrigger,
  savedOutputScrollTarget,
  scrollTargetRef,
  setOutputScrollTarget,
  workflowScrollTargetId,
  bottomThresholdPx,
  commitMaxRetries,
  layoutApplyTrigger,
  userScrollInputGraceMs,
}: UseOutputScrollTargetInput) {
  const scrollTargetCommitTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollTargetCommitRetryCountRef = useRef(0);

  const setCurrentScrollTarget = useCallback(
    (target: OutputScrollTarget, reason: string) => {
      scrollTargetRef.current = target;
      autoscrollEnabledRef.current = target.kind === "bottom";
      setOutputScrollTarget(workflowScrollTargetId, target);

      if (isProfilingEnabled()) {
        logProfilerEvent("scrollTarget", {
          phase: "set",
          reason,
          target,
          workflowId: workflowScrollTargetId,
        });
      }
    },
    [
      autoscrollEnabledRef,
      scrollTargetRef,
      setOutputScrollTarget,
      workflowScrollTargetId,
    ]
  );

  const resolveScrollTopForTarget = useCallback(
    (target: OutputScrollTarget): { top: number; resolved: boolean } | null => {
      const scrollElement = outputRef.current;
      if (!scrollElement) {
        return null;
      }

      const maxScroll = Math.max(
        0,
        Math.max(rowLayout.totalSize, scrollElement.scrollHeight) -
          scrollElement.clientHeight
      );
      if (target.kind === "bottom") {
        return { top: maxScroll, resolved: true };
      }

      let rowStart: number | undefined;
      for (const measurement of rowVirtualizer.measurementsCache) {
        if (measurement != null && String(measurement.key) === target.rowKey) {
          rowStart = measurement.start;
          break;
        }
      }
      rowStart ??= rowLayout.rowStartsByKey.get(target.rowKey);
      if (rowStart == null) {
        return { top: maxScroll, resolved: false };
      }

      return {
        top: clamp(rowStart - target.viewportOffsetPx, 0, maxScroll),
        resolved: true,
      };
    },
    [outputRef, rowLayout, rowVirtualizer]
  );

  const commitScrollTargetFromViewport = useCallback(
    (reason: string) => {
      const scrollElement = outputRef.current;
      if (!scrollElement || rowsRef.current.length === 0) {
        return;
      }

      const atBottom =
        scrollElement.scrollHeight -
          scrollElement.scrollTop -
          scrollElement.clientHeight <=
        bottomThresholdPx;
      if (atBottom) {
        scrollTargetCommitRetryCountRef.current = 0;
        setCurrentScrollTarget(defaultTarget, reason);
        return;
      }

      const anchor = captureViewportRowAnchor(scrollElement, "visible-top");
      if (!anchor) {
        if (scrollTargetCommitRetryCountRef.current < commitMaxRetries) {
          scrollTargetCommitRetryCountRef.current += 1;
          requestAnimationFrame(() =>
            commitScrollTargetFromViewportRef.current(reason)
          );
        } else {
          scrollTargetCommitRetryCountRef.current = 0;
        }
        return;
      }
      scrollTargetCommitRetryCountRef.current = 0;

      setCurrentScrollTarget(
        {
          kind: "row",
          rowKey: anchor.rowKey,
          viewportOffsetPx: anchor.offsetTop,
        },
        reason
      );
    },
    [
      bottomThresholdPx,
      commitMaxRetries,
      commitScrollTargetFromViewportRef,
      defaultTarget,
      outputRef,
      rowsRef,
      setCurrentScrollTarget,
    ]
  );

  const applyScrollTarget = useCallback(
    (
      phase: string,
      options?: { force?: boolean }
    ): { resolved: boolean; appliedDelta: number } => {
      const scrollElement = outputRef.current;
      if (!scrollElement || rowsRef.current.length === 0) {
        return { resolved: false, appliedDelta: 0 };
      }

      const now = performance.now();
      const hasRecentUserScrollInput =
        (lastUserScrollInputAtRef.current != null &&
          now - lastUserScrollInputAtRef.current <= userScrollInputGraceMs) ||
        (lastScrollEventAtRef.current != null &&
          now - lastScrollEventAtRef.current <= userScrollInputGraceMs);
      if (
        !options?.force &&
        (hasRecentUserScrollInput || pendingNavigationRef.current !== null)
      ) {
        return { resolved: false, appliedDelta: 0 };
      }

      if (scrollTargetCommitTimerRef.current !== null) {
        clearTimeout(scrollTargetCommitTimerRef.current);
        scrollTargetCommitTimerRef.current = null;
        commitScrollTargetFromViewportRef.current(`${phase}-pending-commit-flush`);
      }

      if (
        scrollTargetRef.current.kind === "bottom" &&
        !autoscrollEnabledRef.current
      ) {
        commitScrollTargetFromViewportRef.current(`${phase}-stale-bottom-refresh`);
      }

      const target = scrollTargetRef.current;
      const resolved = resolveScrollTopForTarget(target);
      if (!resolved) {
        return { resolved: false, appliedDelta: 0 };
      }

      if (!resolved.resolved && target.kind === "row") {
        setCurrentScrollTarget(defaultTarget, "target-missing");
      }

      const previous = scrollElement.scrollTop;
      const appliedDelta = resolved.top - previous;
      if (Math.abs(appliedDelta) >= 1) {
        isProgrammaticScrollRef.current = true;
        scrollElement.scrollTop = resolved.top;
        lastScrollTopRef.current = scrollElement.scrollTop;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      }

      if (
        isProfilingEnabled() &&
        (Math.abs(appliedDelta) >= 1 || !resolved.resolved)
      ) {
        logProfilerEvent("scrollTarget", {
          phase: "apply",
          reason: phase,
          target,
          resolved: resolved.resolved,
          appliedDelta,
          scrollTop: scrollElement.scrollTop,
          overscan: outputOverscanRef.current,
        });
      }

      return { resolved: resolved.resolved, appliedDelta };
    },
    [
      autoscrollEnabledRef,
      commitScrollTargetFromViewportRef,
      defaultTarget,
      isProgrammaticScrollRef,
      lastScrollEventAtRef,
      lastScrollTopRef,
      lastUserScrollInputAtRef,
      outputOverscanRef,
      outputRef,
      pendingNavigationRef,
      resolveScrollTopForTarget,
      rowsRef,
      scrollTargetRef,
      setCurrentScrollTarget,
      userScrollInputGraceMs,
    ]
  );

  applyScrollTargetRef.current = applyScrollTarget;
  commitScrollTargetFromViewportRef.current = commitScrollTargetFromViewport;

  const scheduleScrollTargetCommit = useCallback(
    (reason: string) => {
      if (scrollTargetCommitTimerRef.current !== null) {
        clearTimeout(scrollTargetCommitTimerRef.current);
      }
      scrollTargetCommitTimerRef.current = setTimeout(() => {
        scrollTargetCommitTimerRef.current = null;
        commitScrollTargetFromViewport(reason);
      }, userScrollInputGraceMs);
    },
    [commitScrollTargetFromViewport, userScrollInputGraceMs]
  );

  useLayoutEffect(() => {
    void layoutApplyTrigger;
    applyScrollTarget("layout-effect");
  }, [applyScrollTarget, layoutApplyTrigger]);

  useEffect(() => {
    void restoreTrigger;
    const nextTarget = savedOutputScrollTarget ?? defaultTarget;
    scrollTargetRef.current = nextTarget;
    autoscrollEnabledRef.current = nextTarget.kind === "bottom";
    requestAnimationFrame(() => {
      applyScrollTargetRef.current("workflow-target-restore", { force: true });
    });
  }, [
    applyScrollTargetRef,
    autoscrollEnabledRef,
    defaultTarget,
    restoreTrigger,
    savedOutputScrollTarget,
    scrollTargetRef,
    workflowScrollTargetId,
  ]);

  useEffect(
    () => () => {
      if (scrollTargetCommitTimerRef.current !== null) {
        clearTimeout(scrollTargetCommitTimerRef.current);
        scrollTargetCommitTimerRef.current = null;
      }
    },
    []
  );

  return {
    applyScrollTarget,
    commitScrollTargetFromViewport,
    scheduleScrollTargetCommit,
    setCurrentScrollTarget,
  };
}
