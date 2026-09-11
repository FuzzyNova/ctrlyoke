import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import {
  areOutputScrollTargetsEqual,
  type OutputScrollTarget,
} from "@store/uiStore";
import {
  captureViewportRowAnchor,
  findRenderedRowElementByKey,
} from "@utils/outputDom";
import {
  getTargetKey,
  type OutputMessageTarget,
} from "@utils/outputProjection";
import { resolveDeferredScrollTargetApplyDelayMs } from "@utils/outputAutoscroll";
import { clamp } from "@utils/number";
import {
  isProfilingEnabled,
  logProfilerEvent,
} from "@utils/performanceProfiler";
import {
  OUTPUT_ROW_KINDS,
  OUTPUT_SCROLL_ANCHOR_MODES,
  OUTPUT_SCROLL_TARGET_KINDS,
  type OutputRowKind,
} from "@root/types/DashboardConstants";

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

interface ResolvedScrollTop {
  top: number;
  resolved: boolean;
  /**
   * Where the anchor row actually sits in the viewport right now, when it was
   * resolved from live DOM geometry. Diagnostic only: comparing successive
   * values tells whether a correction is compensating movement the browser
   * already painted (`observedOffsetPx` changed by the same amount we are about
   * to apply, so the net effect is invisible) or introducing movement of its
   * own (`observedOffsetPx` unchanged, so the correction *is* the jump).
   */
  observedOffsetPx?: number;
}

interface UseOutputScrollTargetInput {
  applyScrollTargetRef: RefObject<
    (
      phase: string,
      options?: { force?: boolean }
    ) => {
      resolved: boolean;
      appliedDelta: number;
    }
  >;
  autoscrollEnabledRef: RefObject<boolean>;
  commitScrollTargetFromViewportRef: RefObject<(reason: string) => void>;
  defaultTarget: OutputScrollTarget;
  isLatestActivityFollowEnabled?: boolean;
  latestActivityRowKey?: string;
  isProgrammaticScrollRef: RefObject<boolean>;
  lastProgrammaticScrollTopRef: RefObject<number | null>;
  lastScrollEventAtRef: RefObject<number | null>;
  lastScrollTopRef: RefObject<number | null>;
  lastUserScrollInputAtRef: RefObject<number | null>;
  outputOverscanRef: RefObject<number>;
  outputRef: RefObject<HTMLDivElement | null>;
  pendingNavigationRef: RefObject<unknown | null>;
  rowLayout: OutputRowLayoutModel;
  rowVirtualizer: RowVirtualizerLike;
  rows?: readonly OutputScrollRow[];
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

interface OutputScrollRow {
  key: string;
  rowKind: OutputRowKind;
  target: OutputMessageTarget;
}

const EMPTY_OUTPUT_SCROLL_ROWS: readonly OutputScrollRow[] = [];

function targetIsLatestActivityAndStillVisible(
  scrollElement: HTMLDivElement,
  target: OutputScrollTarget
): boolean {
  if (target.kind !== OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY) {
    return false;
  }
  const rowElement = findRenderedRowElementByKey(scrollElement, target.rowKey);
  if (!rowElement) return false;
  const scrollRect = scrollElement.getBoundingClientRect();
  const rowRect = rowElement.getBoundingClientRect();
  return rowRect.bottom > scrollRect.top && rowRect.top < scrollRect.bottom;
}

export function useOutputScrollTarget({
  applyScrollTargetRef,
  autoscrollEnabledRef,
  commitScrollTargetFromViewportRef,
  defaultTarget,
  isLatestActivityFollowEnabled = false,
  latestActivityRowKey,
  isProgrammaticScrollRef,
  lastProgrammaticScrollTopRef,
  lastScrollEventAtRef,
  lastScrollTopRef,
  lastUserScrollInputAtRef,
  outputOverscanRef,
  outputRef,
  pendingNavigationRef,
  rowLayout,
  rowVirtualizer,
  rows,
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
  const scrollTargetCommitTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const deferredScrollTargetApplyTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const scrollTargetCommitRetryCountRef = useRef(0);
  // Diagnostics for the apply log only — never read by behaviour.
  const lastObservedAnchorOffsetRef = useRef<number | null>(null);
  const lastApplyAtRef = useRef<number | null>(null);
  const previousRestoreTriggerRef = useRef<string | null>(null);
  const previousWorkflowScrollTargetIdRef = useRef<string | null>(null);
  const previousRowsRef = useRef<readonly OutputScrollRow[]>(
    rows ?? EMPTY_OUTPUT_SCROLL_ROWS
  );

  const setCurrentScrollTarget = useCallback(
    (target: OutputScrollTarget, reason: string) => {
      const previousTarget = scrollTargetRef.current;
      scrollTargetRef.current = target;
      autoscrollEnabledRef.current =
        target.kind === OUTPUT_SCROLL_TARGET_KINDS.BOTTOM ||
        target.kind === OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY;
      setOutputScrollTarget(workflowScrollTargetId, target);

      if (isProfilingEnabled()) {
        logProfilerEvent("scrollTarget", {
          phase: "set",
          reason,
          target,
          // Re-anchoring the same row at a different offset means the pane
          // settled somewhere other than where the user left it and this commit
          // is accepting that as the new resting place — the signature of a
          // jump that never returns.
          offsetDriftPx:
            previousTarget.kind !== OUTPUT_SCROLL_TARGET_KINDS.BOTTOM &&
            target.kind !== OUTPUT_SCROLL_TARGET_KINDS.BOTTOM &&
            previousTarget.rowKey === target.rowKey
              ? target.viewportOffsetPx - previousTarget.viewportOffsetPx
              : undefined,
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
    (target: OutputScrollTarget): ResolvedScrollTop | null => {
      const scrollElement = outputRef.current;
      if (!scrollElement) {
        return null;
      }

      const maxScroll = Math.max(
        0,
        Math.max(rowLayout.totalSize, scrollElement.scrollHeight) -
          scrollElement.clientHeight
      );
      if (target.kind === OUTPUT_SCROLL_TARGET_KINDS.BOTTOM) {
        return { top: maxScroll, resolved: true };
      }

      // The target is normally one of the visible rows. Resolve it from the
      // committed DOM so the lock follows what the user actually sees, rather
      // than a virtualizer start that may still be converging as idle overscan
      // mounts and measures nearby rows. This also preserves the coordinate
      // offset of content rendered before the row canvas (the run banner).
      const renderedTarget = findRenderedRowElementByKey(
        scrollElement,
        target.rowKey
      );
      if (renderedTarget) {
        const scrollRect = scrollElement.getBoundingClientRect();
        const rowRect = renderedTarget.getBoundingClientRect();
        const observedOffsetPx = rowRect.top - scrollRect.top;
        return {
          top: clamp(
            scrollElement.scrollTop +
              observedOffsetPx -
              target.viewportOffsetPx,
            0,
            maxScroll
          ),
          resolved: true,
          observedOffsetPx,
        };
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

      const rowContainer = scrollElement.querySelector<HTMLElement>(
        "[data-output-row-container]"
      );
      const rowContainerOffset = rowContainer
        ? scrollElement.scrollTop +
          rowContainer.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top
        : 0;

      return {
        top: clamp(
          rowContainerOffset + rowStart - target.viewportOffsetPx,
          0,
          maxScroll
        ),
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
      // The auto-scroll latch outranks raw geometry. While it is armed the view
      // is *meant* to be at the bottom even if streaming content has temporarily
      // outgrown it, so committing a row anchor here would silently unpin the
      // pane (setCurrentScrollTarget disarms on any non-bottom target).
      let releasedLatestActivity = false;
      if (
        scrollTargetRef.current.kind ===
        OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY
      ) {
        if (
          autoscrollEnabledRef.current &&
          targetIsLatestActivityAndStillVisible(
            scrollElement,
            scrollTargetRef.current
          )
        ) {
          scrollTargetCommitRetryCountRef.current = 0;
          return;
        }
        autoscrollEnabledRef.current = false;
        releasedLatestActivity = true;
      }
      if (
        autoscrollEnabledRef.current ||
        (!releasedLatestActivity && atBottom)
      ) {
        scrollTargetCommitRetryCountRef.current = 0;
        setCurrentScrollTarget(defaultTarget, reason);
        return;
      }

      const anchor = captureViewportRowAnchor(
        scrollElement,
        OUTPUT_SCROLL_ANCHOR_MODES.VISIBLE_TOP
      );
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
          kind: OUTPUT_SCROLL_TARGET_KINDS.ROW,
          rowKey: anchor.rowKey,
          viewportOffsetPx: anchor.offsetTop,
        },
        reason
      );
    },
    [
      autoscrollEnabledRef,
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
        if (hasRecentUserScrollInput && pendingNavigationRef.current === null) {
          if (deferredScrollTargetApplyTimerRef.current !== null) {
            clearTimeout(deferredScrollTargetApplyTimerRef.current);
          }
          const deferredApplyDelayMs = resolveDeferredScrollTargetApplyDelayMs({
            now,
            lastUserScrollInputAt: lastUserScrollInputAtRef.current,
            lastScrollEventAt: lastScrollEventAtRef.current,
            userScrollInputGraceMs,
          });
          deferredScrollTargetApplyTimerRef.current = setTimeout(() => {
            deferredScrollTargetApplyTimerRef.current = null;
            applyScrollTargetRef.current(`${phase}-deferred`);
          }, deferredApplyDelayMs);
        }
        return { resolved: false, appliedDelta: 0 };
      }

      if (deferredScrollTargetApplyTimerRef.current !== null) {
        clearTimeout(deferredScrollTargetApplyTimerRef.current);
        deferredScrollTargetApplyTimerRef.current = null;
      }

      if (scrollTargetCommitTimerRef.current !== null) {
        clearTimeout(scrollTargetCommitTimerRef.current);
        scrollTargetCommitTimerRef.current = null;
        commitScrollTargetFromViewportRef.current(
          `${phase}-pending-commit-flush`
        );
      }

      if (
        scrollTargetRef.current.kind === OUTPUT_SCROLL_TARGET_KINDS.BOTTOM &&
        !autoscrollEnabledRef.current
      ) {
        commitScrollTargetFromViewportRef.current(
          `${phase}-stale-bottom-refresh`
        );
      }

      const target = scrollTargetRef.current;
      const resolved = resolveScrollTopForTarget(target);
      if (!resolved) {
        return { resolved: false, appliedDelta: 0 };
      }

      if (
        !resolved.resolved &&
        target.kind !== OUTPUT_SCROLL_TARGET_KINDS.BOTTOM
      ) {
        setCurrentScrollTarget(defaultTarget, "target-missing");
      }

      const previous = scrollElement.scrollTop;
      const appliedDelta = resolved.top - previous;
      if (Math.abs(appliedDelta) >= 1) {
        isProgrammaticScrollRef.current = true;
        scrollElement.scrollTop = resolved.top;
        lastScrollTopRef.current = scrollElement.scrollTop;
        // Record *where* we put the pane, not just that we moved it. The scroll
        // event this write produces can arrive after `isProgrammaticScrollRef`
        // has already been lowered (see the echo guard in OutputSection's
        // handleScroll), and only the position identifies it as ours.
        lastProgrammaticScrollTopRef.current = scrollElement.scrollTop;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      }

      if (
        isProfilingEnabled() &&
        (Math.abs(appliedDelta) >= 1 || !resolved.resolved)
      ) {
        const previousObservedOffsetPx = lastObservedAnchorOffsetRef.current;
        logProfilerEvent("scrollTarget", {
          phase: "apply",
          reason: phase,
          target,
          resolved: resolved.resolved,
          appliedDelta,
          scrollTop: scrollElement.scrollTop,
          // scrollTop is read back after the write: a value that does not match
          // `resolved.top` means the browser refused or clamped it, which makes
          // the next apply resolve a delta that looks like fresh drift.
          scrollTopHonored:
            Math.abs(scrollElement.scrollTop - resolved.top) < 1,
          // Where the anchor row was, and how far it had moved since the last
          // apply. `anchorMovedSinceLastApply ~= appliedDelta` is a correction
          // that cancels a real shift and paints as no movement at all; ~0 with
          // a non-zero appliedDelta means this apply is itself the visible jump.
          observedOffsetPx: resolved.observedOffsetPx,
          anchorMovedSinceLastApply:
            resolved.observedOffsetPx != null &&
            previousObservedOffsetPx != null
              ? resolved.observedOffsetPx - previousObservedOffsetPx
              : undefined,
          msSinceLastApply:
            lastApplyAtRef.current == null
              ? undefined
              : now - lastApplyAtRef.current,
          overscan: outputOverscanRef.current,
        });
      }
      lastObservedAnchorOffsetRef.current = resolved.observedOffsetPx ?? null;
      lastApplyAtRef.current = now;

      return { resolved: resolved.resolved, appliedDelta };
    },
    [
      autoscrollEnabledRef,
      commitScrollTargetFromViewportRef,
      defaultTarget,
      isProgrammaticScrollRef,
      lastProgrammaticScrollTopRef,
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

  const preserveTargetForRenderedRows = useCallback(
    (target: OutputScrollTarget): OutputScrollTarget => {
      if (target.kind === OUTPUT_SCROLL_TARGET_KINDS.BOTTOM) {
        return target;
      }

      if (!rows || rows.some((row) => row.key === target.rowKey)) {
        return target;
      }

      const previousAnchor = previousRowsRef.current.find(
        (row) => row.key === target.rowKey
      );
      if (!previousAnchor?.target) {
        return target;
      }

      const targetKey = getTargetKey(previousAnchor.target);
      const placeholder = rows.find(
        (row) =>
          row.rowKind === OUTPUT_ROW_KINDS.STEP_HIDDEN &&
          getTargetKey(row.target) === targetKey
      );
      return placeholder ? { ...target, rowKey: placeholder.key } : target;
    },
    [rows]
  );

  // A filter removes content rows but deliberately leaves the step anchor. If
  // the saved anchor was one of the removed content rows, move it to the
  // step's placeholder before the anchor-lock layout effect runs. This keeps
  // the lock as the only scrollTop writer and preserves the viewport offset.
  useLayoutEffect(() => {
    const currentTarget = scrollTargetRef.current;
    const preservedTarget = preserveTargetForRenderedRows(currentTarget);
    if (areOutputScrollTargetsEqual(currentTarget, preservedTarget)) {
      return;
    }

    setCurrentScrollTarget(preservedTarget, "hidden-output-placeholder");
  }, [preserveTargetForRenderedRows, scrollTargetRef, setCurrentScrollTarget]);

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

  useEffect(() => {
    void restoreTrigger;
    const restoredTarget = preserveTargetForRenderedRows(
      savedOutputScrollTarget ?? defaultTarget
    );
    const nextTarget =
      isLatestActivityFollowEnabled &&
      latestActivityRowKey &&
      restoredTarget.kind === OUTPUT_SCROLL_TARGET_KINDS.BOTTOM
        ? {
            kind: OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY,
            rowKey: latestActivityRowKey,
            viewportOffsetPx: 0,
          }
        : restoredTarget;
    const restoreContextChanged =
      previousRestoreTriggerRef.current !== restoreTrigger ||
      previousWorkflowScrollTargetIdRef.current !== workflowScrollTargetId;
    previousRestoreTriggerRef.current = restoreTrigger;
    previousWorkflowScrollTargetIdRef.current = workflowScrollTargetId;
    if (
      !restoreContextChanged &&
      areOutputScrollTargetsEqual(scrollTargetRef.current, nextTarget)
    ) {
      return;
    }

    scrollTargetRef.current = nextTarget;
    autoscrollEnabledRef.current =
      nextTarget.kind === OUTPUT_SCROLL_TARGET_KINDS.BOTTOM ||
      nextTarget.kind === OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY;
    if (
      savedOutputScrollTarget &&
      !areOutputScrollTargetsEqual(savedOutputScrollTarget, nextTarget)
    ) {
      setOutputScrollTarget(workflowScrollTargetId, nextTarget);
    }
    requestAnimationFrame(() => {
      applyScrollTargetRef.current("workflow-target-restore", { force: true });
    });
  }, [
    applyScrollTargetRef,
    autoscrollEnabledRef,
    defaultTarget,
    isLatestActivityFollowEnabled,
    latestActivityRowKey,
    restoreTrigger,
    savedOutputScrollTarget,
    preserveTargetForRenderedRows,
    scrollTargetRef,
    setOutputScrollTarget,
    workflowScrollTargetId,
  ]);

  useLayoutEffect(() => {
    if (
      !isLatestActivityFollowEnabled ||
      !latestActivityRowKey ||
      !autoscrollEnabledRef.current
    ) {
      return;
    }
    const currentTarget = scrollTargetRef.current;
    const nextTarget: OutputScrollTarget = {
      kind: OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY,
      rowKey: latestActivityRowKey,
      viewportOffsetPx:
        currentTarget.kind === OUTPUT_SCROLL_TARGET_KINDS.LATEST_ACTIVITY &&
        currentTarget.rowKey === latestActivityRowKey
          ? currentTarget.viewportOffsetPx
          : 0,
    };
    if (areOutputScrollTargetsEqual(currentTarget, nextTarget)) {
      return;
    }
    setCurrentScrollTarget(nextTarget, "latest-activity");
  }, [
    autoscrollEnabledRef,
    isLatestActivityFollowEnabled,
    latestActivityRowKey,
    scrollTargetRef,
    setCurrentScrollTarget,
  ]);

  useLayoutEffect(() => {
    void layoutApplyTrigger;
    applyScrollTarget("layout-effect");
  }, [applyScrollTarget, layoutApplyTrigger]);

  useEffect(() => {
    if (rows) {
      previousRowsRef.current = rows;
    }
  }, [rows]);

  useEffect(
    () => () => {
      if (scrollTargetCommitTimerRef.current !== null) {
        clearTimeout(scrollTargetCommitTimerRef.current);
        scrollTargetCommitTimerRef.current = null;
      }
      if (deferredScrollTargetApplyTimerRef.current !== null) {
        clearTimeout(deferredScrollTargetApplyTimerRef.current);
        deferredScrollTargetApplyTimerRef.current = null;
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
