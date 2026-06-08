import { useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { OutputMessageTarget } from "@utils/outputProjection";
import {
  alignRowElementToViewport,
  findRenderedRowElement,
  getEstimatedRowScopedScrollTop,
  getRowScopedScrollTop,
} from "@utils/outputDom";
import {
  setActiveOutputNavigationController,
  type OutputNavigationController,
} from "@utils/outputNavigation";

interface OutputRowLayoutModel {
  rowSizesByKey: Map<string, number>;
  rowStartsByIndex: number[];
  totalSize: number;
}

interface OutputRow {
  key: string;
}

interface PendingNavigationState {
  rowIndex: number;
  align: "start" | "end";
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
    options?: { align?: "start" | "end"; behavior?: ScrollBehavior }
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
  rows: OutputRow[];
  setCurrentScrollTarget: (
    target: { kind: "row"; rowKey: string; viewportOffsetPx: number },
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

  const navigationController: OutputNavigationController = useMemo(
    () => ({
      scrollToTarget: (
        target: OutputMessageTarget,
        options?: { behavior?: ScrollBehavior; align?: "start" | "end" }
      ) => {
        const rowIndex = firstRowIndexByTarget.get(
          `${target.kind}:${target.index}`
        );
        if (rowIndex === undefined || !outputRef.current) {
          return;
        }

        const align = options?.align ?? "start";
        const requestedBehavior = options?.behavior ?? "auto";
        const behavior =
          requestedBehavior === "smooth" ? "auto" : requestedBehavior;
        const row = rows[rowIndex];
        if (row) {
          const rowSize = rowLayout.rowSizesByKey.get(row.key);
          const viewportOffsetPx =
            align === "end"
              ? Math.max(0, outputRef.current.clientHeight - (rowSize ?? 0))
              : 0;
          setCurrentScrollTarget(
            {
              kind: "row",
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
          targetKind: target.kind,
          targetIndex: target.index,
          requestedBehavior,
          effectiveBehavior: behavior,
          startedAt,
          lastMeasuredVersion: measurementVersionRef.current,
          lastMeasurementChangeAt: startedAt,
          attempts: 0,
        };
        setNavigationPendingRowIndex(rowIndex);

        if (!isOutputVirtualized) {
          const rowElement = findRenderedRowElement(
            outputRef.current,
            rowIndex
          );
          const top =
            rowElement != null
              ? getRowScopedScrollTop(outputRef.current, rowElement, align)
              : getEstimatedRowScopedScrollTop(
                  outputRef.current,
                  rowLayout.rowStartsByIndex[rowIndex] ?? 0,
                  rowLayout.rowSizesByKey.get(rows[rowIndex]?.key ?? ""),
                  align
                );
          outputRef.current.scrollTo({ top, behavior: requestedBehavior });
          if (rowElement) {
            lastScrollTopRef.current = top;
          }
          finalizePendingNavigation();
          return;
        }

        rowVirtualizer.scrollToIndex(rowIndex, { align, behavior });
        schedulePendingNavigationStabilization();
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
    }),
    [
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
    ]
  );

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
