import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";

export interface VirtualizedListProps<T> {
  items: T[];
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /**
   * Must be O(1) per call. TanStack may invoke this from the lowest changed
   * row through the end of the list whenever one row reports a new size, so
   * callers should pass a precomputed estimate stored on each item.
   */
  estimateItemSize: (item: T, index: number) => number;
  threshold: number;
  overscan: number;
  layoutResetKey?: string | number;
  /** Scrolls the matching row into view once; a new key starts another scroll. */
  scrollToKey?: string | null;
}

export function VirtualizedList<T>({
  items,
  getItemKey,
  renderItem,
  scrollContainerRef,
  estimateItemSize,
  threshold,
  overscan,
  layoutResetKey,
  scrollToKey = null,
}: VirtualizedListProps<T>): React.ReactElement {
  const shouldVirtualize = items.length >= threshold;

  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [scrollElementReady, markScrollElementResolvable] = useState(false);

  // Keep a focused row in the rendered range even when it falls just outside
  // the normal overscan window. Keyboard focus must not disappear merely
  // because a scroll event moved the row across a virtual boundary.
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
    count: items.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const item = items[index];
      return item === undefined ? 0 : estimateItemSize(item, index);
    },
    overscan,
    rangeExtractor,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : getItemKey(item, index);
    },
  });

  // The scroll container is owned by the *parent* (WorkflowList, RunPanel …),
  // and React attaches a host element's ref only after its children's layout
  // effects have run. So during this component's own mount the virtualizer
  // resolves getScrollElement() to null, never observes the scroller, and
  // renders zero rows — with nothing scheduled to re-resolve it. This one-shot
  // state flip re-renders after mount (before paint), when the parent's ref is
  // attached, so the virtualizer resolves and observes the real scroll
  // element. Flipping an already-true value bails out, so it costs exactly one
  // extra render.
  useLayoutEffect(() => {
    markScrollElementResolvable(true);
  }, []);

  useEffect(() => {
    if (!shouldVirtualize) {
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
      // Let the browser update activeElement before deciding whether focus
      // moved within the same card, to another row, or outside the list.
      queueMicrotask(() => setFocusedIndex(getFocusedRowIndex()));
    };

    container.addEventListener("focusin", handleFocusIn);
    container.addEventListener("focusout", handleFocusOut);
    return () => {
      container.removeEventListener("focusin", handleFocusIn);
      container.removeEventListener("focusout", handleFocusOut);
    };
  }, [scrollContainerRef, scrollElementReady, shouldVirtualize]);

  const previousLayoutResetKeyRef = useRef(layoutResetKey);
  useEffect(() => {
    if (previousLayoutResetKeyRef.current === layoutResetKey) {
      return;
    }
    previousLayoutResetKeyRef.current = layoutResetKey;
    rowVirtualizer.measure();
  }, [layoutResetKey, rowVirtualizer]);

  // Tracks the key already scrolled-to so a re-render with the same target
  // (e.g. items array identity changing but not content) doesn't keep
  // re-issuing scrollIntoView/scrollToIndex and fighting the user's own scroll.
  const scrolledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!scrollToKey || scrolledKeyRef.current === scrollToKey) {
      return;
    }
    const index = items.findIndex(
      (item, itemIndex) => getItemKey(item, itemIndex) === scrollToKey
    );
    if (index === -1) {
      return;
    }
    scrolledKeyRef.current = scrollToKey;
    if (shouldVirtualize) {
      rowVirtualizer.scrollToIndex(index, { align: "center" });
      return;
    }
    const container = scrollContainerRef.current;
    const target = container?.querySelector(
      `[data-scroll-key="${CSS.escape(scrollToKey)}"]`
    );
    // Optional chained on the method itself, not just the element: jsdom
    // (unit tests) has no scrollIntoView implementation at all.
    target?.scrollIntoView?.({ block: "nearest" });
    // items/getItemKey/rowVirtualizer intentionally excluded: re-running on
    // every items-array identity change would fight manual scrolling. Only
    // items.length is tracked, so a target that resolves later (e.g. an async
    // summary fetch that hasn't landed yet on the first pass) still gets
    // scrolled to once its row actually appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToKey, shouldVirtualize, items.length]);

  if (!shouldVirtualize) {
    return (
      <>
        {items.map((item, index) => (
          <React.Fragment key={getItemKey(item, index)}>
            {renderItem(item, index)}
          </React.Fragment>
        ))}
      </>
    );
  }

  return (
    <div
      style={{
        height: rowVirtualizer.getTotalSize(),
        position: "relative",
        width: "100%",
      }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        // Guards an index the virtualizer produced for a stale count; an
        // explicit undefined check (not falsiness) so lists of primitives
        // don't silently drop 0/""/false rows.
        const item = items[virtualRow.index];
        if (item === undefined) return null;

        return (
          <div
            key={virtualRow.key}
            ref={rowVirtualizer.measureElement}
            data-index={virtualRow.index}
            style={{
              position: "absolute",
              top: virtualRow.start,
              left: 0,
              width: "100%",
            }}
          >
            {renderItem(item, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );
}
