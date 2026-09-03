import { useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { OutputMessageTarget } from "@utils/outputProjection";
import type { OutputRowBase } from "@utils/outputRows";
import {
  alignRowElementToViewport,
  findRenderedRowElement,
  getEstimatedRowScopedScrollTop,
  getRowScopedScrollTop,
  revealActiveFindMatchInRow,
} from "@utils/outputDom";
import {
  setActiveOutputNavigationController,
  type OutputNavigationOptions,
  type OutputNavigationController,
} from "@utils/outputNavigation";
import {
  OUTPUT_SCROLL_ALIGNMENTS,
  OUTPUT_SCROLL_TARGET_KINDS,
  OUTPUT_ROW_KINDS,
  type OutputScrollAlignment,
} from "@root/types/DashboardConstants";

interface OutputRowLayoutModel {
  rowSizesByKey: Map<string, number>;
  rowStartsByIndex: number[];
  totalSize: number;
}

interface PendingNavigationState {
  rowIndex: number;
  align: OutputScrollAlignment;
  revealActiveFindMatch: boolean;
  targetKind: OutputMessageTarget["kind"];
  targetIndex: number;
  requestedBehavior: ScrollBehavior;
  effectiveBehavior: ScrollBehavior;
  startedAt: number;
  lastMeasuredVersion: number;
  lastMeasurementChangeAt: number;
  attempts: number;
}

interface RowVirtualizerLike {
  scrollToIndex: (
    index: number,
    options?: {
      align?: OutputScrollAlignment;
      behavior?: ScrollBehavior;
    }
  ) => void;
  scrollToOffset: (
    offset: number,
    options?: { behavior?: ScrollBehavior }
  ) => void;
}

interface UseOutputNavigationInput {
  autoscrollEnabledRef: RefObject<boolean>;
  finalizeSettlingDelayMs: number;
  firstRowIndexByTarget: Map<string, number>;
  isOutputVirtualized: boolean;
  isProgrammaticScrollRef: RefObject<boolean>;
  lastScrollTopRef: RefObject<number | null>;
  maxAlignmentAttempts: number;
  maxStabilizationMs: number;
  measurementVersion: number;
  measurementVersionRef: RefObject<number>;
  navigationFrameRef: RefObject<number | null>;
  outputRef: RefObject<HTMLDivElement | null>;
  pendingNavigationRef: RefObject<PendingNavigationState | null>;
  postNavSettlingRef: RefObject<boolean>;
  postNavSettlingTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  rowLayout: OutputRowLayoutModel;
  rowVirtualizer: RowVirtualizerLike;
  rows: OutputRowBase[];
  setCurrentScrollTarget: (
    target: {
      kind: typeof OUTPUT_SCROLL_TARGET_KINDS.ROW;
      rowKey: string;
      viewportOffsetPx: number;
    },
    reason: string
  ) => void;
}

export function useOutputNavigation({
  autoscrollEnabledRef,
  finalizeSettlingDelayMs,
  firstRowIndexByTarget,
  isOutputVirtualized,
  isProgrammaticScrollRef,
  lastScrollTopRef,
  maxAlignmentAttempts,
  maxStabilizationMs,
  measurementVersion,
  measurementVersionRef,
  navigationFrameRef,
  outputRef,
  pendingNavigationRef,
  postNavSettlingRef,
  postNavSettlingTimerRef,
  rowLayout,
  rowVirtualizer,
  rows,
  setCurrentScrollTarget,
}: UseOutputNavigationInput) {
  const [navigationPendingRowIndex, setNavigationPendingRowIndex] = useState<
    number | null
  >(null);

  const clearNavigationFrame = useCallback(() => {
    if (navigationFrameRef.current != null) {
      cancelAnimationFrame(navigationFrameRef.current);
      navigationFrameRef.current = null;
    }
  }, [navigationFrameRef]);

  const finalizePendingNavigation = useCallback(() => {
    clearNavigationFrame();
    pendingNavigationRef.current = null;
    setNavigationPendingRowIndex(null);
    isProgrammaticScrollRef.current = false;

    const landingScrollTop = outputRef.current?.scrollTop ?? 0;
    rowVirtualizer.scrollToOffset(landingScrollTop, { behavior: "auto" });

    postNavSettlingRef.current = true;
    if (postNavSettlingTimerRef.current !== null) {
      clearTimeout(postNavSettlingTimerRef.current);
    }
    postNavSettlingTimerRef.current = setTimeout(() => {
      postNavSettlingRef.current = false;
      postNavSettlingTimerRef.current = null;
    }, finalizeSettlingDelayMs);
  }, [
    clearNavigationFrame,
    finalizeSettlingDelayMs,
    isProgrammaticScrollRef,
    outputRef,
    pendingNavigationRef,
    postNavSettlingRef,
    postNavSettlingTimerRef,
    rowVirtualizer,
  ]);

  const schedulePendingNavigationStabilization = useCallback(() => {
    clearNavigationFrame();
    navigationFrameRef.current = requestAnimationFrame(() => {
      navigationFrameRef.current = null;
      const pending = pendingNavigationRef.current;
      if (!pending) {
        return;
      }

      const now = performance.now();
      const currentMeasurementVersion = measurementVersionRef.current;
      if (currentMeasurementVersion !== pending.lastMeasuredVersion) {
        pending.lastMeasuredVersion = currentMeasurementVersion;
        pending.lastMeasurementChangeAt = now;
      }

      const scrollElement = outputRef.current;
      if (!scrollElement) {
        finalizePendingNavigation();
        return;
      }

      const rowElement = findRenderedRowElement(
        scrollElement,
        pending.rowIndex
      );
      if (!rowElement) {
        if (
          pending.attempts >= maxAlignmentAttempts ||
          now - pending.startedAt >= maxStabilizationMs
        ) {
          finalizePendingNavigation();
          return;
        }

        pending.attempts += 1;
        rowVirtualizer.scrollToIndex(pending.rowIndex, {
          align: pending.align,
          behavior: "auto",
        });
        schedulePendingNavigationStabilization();
        return;
      }

      if (pending.revealActiveFindMatch) {
        const revealResult = revealActiveFindMatchInRow(
          scrollElement,
          pending.rowIndex
        );
        if (revealResult.foundMark) {
          if (revealResult.rowKey && revealResult.rowViewportOffsetPx != null) {
            setCurrentScrollTarget(
              {
                kind: OUTPUT_SCROLL_TARGET_KINDS.ROW,
                rowKey: revealResult.rowKey,
                viewportOffsetPx: revealResult.rowViewportOffsetPx,
              },
              "navigation-find-match"
            );
          }
          finalizePendingNavigation();
          return;
        }

        if (
          pending.attempts >= maxAlignmentAttempts ||
          now - pending.startedAt >= maxStabilizationMs
        ) {
          finalizePendingNavigation();
          return;
        }

        pending.attempts += 1;
        schedulePendingNavigationStabilization();
        return;
      }

      const isAligned = alignRowElementToViewport(
        scrollElement,
        rowElement,
        pending.align
      );
      if (isAligned) {
        finalizePendingNavigation();
        return;
      }

      if (
        pending.attempts >= maxAlignmentAttempts ||
        now - pending.startedAt >= maxStabilizationMs
      ) {
        finalizePendingNavigation();
        return;
      }

      pending.attempts += 1;
      rowVirtualizer.scrollToIndex(pending.rowIndex, {
        align: pending.align,
        behavior: "auto",
      });
      schedulePendingNavigationStabilization();
    });
  }, [
    clearNavigationFrame,
    finalizePendingNavigation,
    maxAlignmentAttempts,
    maxStabilizationMs,
    measurementVersionRef,
    navigationFrameRef,
    outputRef,
    pendingNavigationRef,
    rowVirtualizer,
    setCurrentScrollTarget,
  ]);

  useEffect(() => {
    if (navigationPendingRowIndex == null) {
      return;
    }
    if (navigationFrameRef.current === null) {
      schedulePendingNavigationStabilization();
    }
  }, [
    measurementVersion,
    navigationFrameRef,
    navigationPendingRowIndex,
    schedulePendingNavigationStabilization,
  ]);

  const navigationController: OutputNavigationController = useMemo(() => {
    const scrollToRowIndex = (
      rowIndex: number,
      options?: OutputNavigationOptions
    ) => {
      if (rowIndex === undefined || !outputRef.current) {
        return;
      }

      const align = options?.align ?? OUTPUT_SCROLL_ALIGNMENTS.START;
      const revealActiveFindMatch = options?.revealActiveFindMatch ?? false;
      const requestedBehavior = options?.behavior ?? "auto";
      const behavior =
        requestedBehavior === "smooth" ? "auto" : requestedBehavior;
      const row = rows[rowIndex];
      if (!row?.target) {
        return;
      }
      if (row) {
        const rowSize = rowLayout.rowSizesByKey.get(row.key);
        const viewportOffsetPx =
          align === OUTPUT_SCROLL_ALIGNMENTS.END
            ? Math.max(0, outputRef.current.clientHeight - (rowSize ?? 0))
            : align === OUTPUT_SCROLL_ALIGNMENTS.CENTER
              ? Math.max(
                  0,
                  outputRef.current.clientHeight / 2 - (rowSize ?? 0) / 2
                )
              : 0;
        setCurrentScrollTarget(
          {
            kind: OUTPUT_SCROLL_TARGET_KINDS.ROW,
            rowKey: row.key,
            viewportOffsetPx,
          },
          "navigation"
        );
      } else {
        autoscrollEnabledRef.current = false;
      }
      isProgrammaticScrollRef.current = true;
      const startedAt = performance.now();
      pendingNavigationRef.current = {
        rowIndex,
        align,
        revealActiveFindMatch,
        targetKind: row.target.kind,
        targetIndex: row.target.index,
        requestedBehavior,
        effectiveBehavior: behavior,
        startedAt,
        lastMeasuredVersion: measurementVersionRef.current,
        lastMeasurementChangeAt: startedAt,
        attempts: 0,
      };
      setNavigationPendingRowIndex(rowIndex);

      if (!isOutputVirtualized) {
        const rowElement = findRenderedRowElement(outputRef.current, rowIndex);
        const top =
          rowElement != null
            ? getRowScopedScrollTop(outputRef.current, rowElement, align)
            : getEstimatedRowScopedScrollTop(
                outputRef.current,
                rowLayout.rowStartsByIndex[rowIndex] ?? 0,
                rowLayout.rowSizesByKey.get(rows[rowIndex]?.key ?? ""),
                align
              );
        outputRef.current.scrollTo({ top, behavior });
        if (rowElement) {
          lastScrollTopRef.current = top;
        }
        if (revealActiveFindMatch) {
          const revealResult = revealActiveFindMatchInRow(
            outputRef.current,
            rowIndex
          );
          if (
            revealResult.foundMark &&
            revealResult.rowKey &&
            revealResult.rowViewportOffsetPx != null
          ) {
            setCurrentScrollTarget(
              {
                kind: OUTPUT_SCROLL_TARGET_KINDS.ROW,
                rowKey: revealResult.rowKey,
                viewportOffsetPx: revealResult.rowViewportOffsetPx,
              },
              "navigation-find-match"
            );
          }
        }
        finalizePendingNavigation();
        return;
      }

      rowVirtualizer.scrollToIndex(rowIndex, { align, behavior });
      schedulePendingNavigationStabilization();
    };

    return {
      scrollToRowIndex,
      scrollToTarget: (
        target: OutputMessageTarget,
        options?: OutputNavigationOptions
      ) => {
        const targetKey = `${target.kind}:${target.index}`;
        const firstRowIndex = firstRowIndexByTarget.get(targetKey);
        if (firstRowIndex === undefined) {
          return;
        }

        // Hidden targets retain a one-pixel anchor for minimap positioning,
        // followed by their visible placeholder. Navigation should land on
        // the placeholder so the user can see the hidden-step affordance.
        const rowIndex =
          rows[firstRowIndex]?.rowKind === OUTPUT_ROW_KINDS.STEP_ANCHOR &&
          rows[firstRowIndex + 1]?.rowKind === OUTPUT_ROW_KINDS.STEP_HIDDEN &&
          rows[firstRowIndex + 1]?.target.kind === target.kind &&
          rows[firstRowIndex + 1]?.target.index === target.index
            ? firstRowIndex + 1
            : firstRowIndex;

        scrollToRowIndex(rowIndex, options);
      },
      getTargetScrollFraction: (target: OutputMessageTarget) => {
        const rowIndex = firstRowIndexByTarget.get(
          `${target.kind}:${target.index}`
        );
        const totalSize = Math.max(1, rowLayout.totalSize);
        if (rowIndex === undefined || totalSize <= 0) {
          return null;
        }

        return rowLayout.rowStartsByIndex[rowIndex] / totalSize;
      },
    };
  }, [
    autoscrollEnabledRef,
    finalizePendingNavigation,
    firstRowIndexByTarget,
    isOutputVirtualized,
    isProgrammaticScrollRef,
    lastScrollTopRef,
    measurementVersionRef,
    outputRef,
    pendingNavigationRef,
    rowLayout,
    rowVirtualizer,
    rows,
    schedulePendingNavigationStabilization,
    setCurrentScrollTarget,
  ]);

  useEffect(() => {
    setActiveOutputNavigationController(navigationController);
    return () => {
      setActiveOutputNavigationController(null);
    };
  }, [navigationController]);

  useEffect(
    () => () => {
      clearNavigationFrame();
      pendingNavigationRef.current = null;
    },
    [clearNavigationFrame, pendingNavigationRef]
  );

  return {
    navigationController,
    navigationPendingRowIndex,
  };
}

export type { PendingNavigationState };
