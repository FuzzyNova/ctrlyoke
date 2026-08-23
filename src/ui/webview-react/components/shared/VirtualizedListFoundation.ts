import { useVirtualizer } from "@tanstack/react-virtual";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { defaultRangeExtractor } from "@tanstack/react-virtual";

export interface VirtualizedListRange {
  /** The currently visible range, inclusive. */
  visibleStartIndex: number;
  visibleEndIndex: number;
  /** The visible range expanded by the virtualizer overscan, inclusive. */
  overscanStartIndex: number;
  overscanEndIndex: number;
  /** Aliases for consumers that only need the visible range. */
  startIndex: number;
  endIndex: number;
}

interface VirtualizedListFoundationOptions {
  count: number;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  estimateSize: (index: number) => number;
  getItemKey: (index: number) => React.Key;
  overscan: number;
  focusRetentionEnabled?: boolean;
  layoutResetKey?: string | number;
  rangeNotificationKey?: string | number;
  onRangeChange?: (range: VirtualizedListRange) => void;
}

/**
 * Shared TanStack wiring for dense and sparse lists.
 *
 * The scroll element is deliberately resolved after the parent has attached
 * its ref. React runs a child's layout effects before the host ref callback,
 * so omitting this one-shot render leaves a parent-owned virtualizer blank.
 */
export function useVirtualizedListFoundation({
  count,
  scrollContainerRef,
  estimateSize,
  getItemKey,
  overscan,
  focusRetentionEnabled = true,
  layoutResetKey,
  rangeNotificationKey,
  onRangeChange,
}: VirtualizedListFoundationOptions) {
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [scrollElementReady, markScrollElementResolvable] = useState(false);

  const rangeExtractor = React.useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = defaultRangeExtractor(range);
      if (
        focusedIndex === null ||
        focusedIndex < 0 ||
        focusedIndex >= range.count ||
        indexes.includes(focusedIndex)
      ) {
        return indexes;
      }
      return [...indexes, focusedIndex].sort((left, right) => left - right);
    },
    [focusedIndex]
  );

  const rowVirtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize,
    overscan,
    rangeExtractor,
    getItemKey,
  });

  useLayoutEffect(() => {
    markScrollElementResolvable(true);
  }, []);

  useEffect(() => {
    // The state is intentionally part of this hook even though TanStack
    // obtains the element through getScrollElement. Its one-shot transition
    // schedules the render that makes the parent-owned ref resolvable.
    if (!scrollElementReady || !focusRetentionEnabled) {
      setFocusedIndex(null);
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) return;

    const getFocusedRowIndex = (): number | null => {
      const activeElement = document.activeElement;
      if (
        !(activeElement instanceof Element) ||
        !container.contains(activeElement)
      ) {
        return null;
      }
      const row = activeElement.closest<HTMLElement>("[data-index]");
      const index = row?.dataset.index;
      return index === undefined ? null : Number(index);
    };

    const handleFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest<HTMLElement>("[data-index]");
      const index = row?.dataset.index;
      setFocusedIndex(index === undefined ? null : Number(index));
    };
    const handleFocusOut = (): void => {
      queueMicrotask(() => setFocusedIndex(getFocusedRowIndex()));
    };

    container.addEventListener("focusin", handleFocusIn);
    container.addEventListener("focusout", handleFocusOut);
    return () => {
      container.removeEventListener("focusin", handleFocusIn);
      container.removeEventListener("focusout", handleFocusOut);
    };
  }, [focusRetentionEnabled, scrollContainerRef, scrollElementReady]);

  const previousLayoutResetKeyRef = useRef(layoutResetKey);
  useEffect(() => {
    if (previousLayoutResetKeyRef.current === layoutResetKey) return;
    previousLayoutResetKeyRef.current = layoutResetKey;
    rowVirtualizer.measure();
  }, [layoutResetKey, rowVirtualizer]);

  const lastRangeNotificationRef = useRef<string | null>(null);
  const rangeStartIndex = rowVirtualizer.range?.startIndex ?? null;
  const rangeEndIndex = rowVirtualizer.range?.endIndex ?? null;
  useEffect(() => {
    if (!onRangeChange || count <= 0) return;

    // Reading the virtual items also materializes the current TanStack range
    // during the first effect pass, before any scroll event has occurred.
    rowVirtualizer.getVirtualItems();
    const visibleRange = rowVirtualizer.range;
    if (!visibleRange) return;

    const nextRange: VirtualizedListRange = {
      visibleStartIndex: visibleRange.startIndex,
      visibleEndIndex: visibleRange.endIndex,
      overscanStartIndex: Math.max(
        0,
        visibleRange.startIndex - Math.max(0, overscan)
      ),
      overscanEndIndex: Math.min(
        count - 1,
        visibleRange.endIndex + Math.max(0, overscan)
      ),
      startIndex: visibleRange.startIndex,
      endIndex: visibleRange.endIndex,
    };
    const notificationSignature = [
      rangeNotificationKey ?? "",
      count,
      nextRange.visibleStartIndex,
      nextRange.visibleEndIndex,
      nextRange.overscanStartIndex,
      nextRange.overscanEndIndex,
    ].join(":");
    if (lastRangeNotificationRef.current === notificationSignature) return;

    lastRangeNotificationRef.current = notificationSignature;
    onRangeChange(nextRange);
  }, [
    count,
    onRangeChange,
    overscan,
    rangeNotificationKey,
    rangeEndIndex,
    rangeStartIndex,
    rowVirtualizer,
  ]);

  return { rowVirtualizer };
}
