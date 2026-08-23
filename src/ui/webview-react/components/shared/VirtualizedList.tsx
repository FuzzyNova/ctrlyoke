import React, { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useVirtualizedListFoundation } from "./VirtualizedListFoundation";

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
  /** Viewport offset for a one-shot scroll-to-key anchor restoration. */
  scrollToKeyOffset?: number;
  /** Optional request identity for repeating the same key intentionally. */
  scrollToKeyRequest?: string | number;
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
  scrollToKeyOffset,
  scrollToKeyRequest,
}: VirtualizedListProps<T>): React.ReactElement {
  const shouldVirtualize = items.length >= threshold;

  const { rowVirtualizer } = useVirtualizedListFoundation({
    count: items.length,
    scrollContainerRef,
    estimateSize: (index) => {
      const item = items[index];
      return item === undefined ? 0 : estimateItemSize(item, index);
    },
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : getItemKey(item, index);
    },
    overscan,
    focusRetentionEnabled: shouldVirtualize,
    layoutResetKey,
  });

  // Tracks the key/request already scrolled-to so a re-render with the same target
  // (e.g. items array identity changing but not content) doesn't keep
  // re-issuing scrollIntoView/scrollToIndex and fighting the user's own scroll.
  const scrolledKeyRef = useRef<{
    key: string;
    request: string | number;
  } | null>(null);
  useEffect(() => {
    if (
      !scrollToKey ||
      (scrolledKeyRef.current?.key === scrollToKey &&
        scrolledKeyRef.current.request === (scrollToKeyRequest ?? scrollToKey))
    ) {
      return;
    }
    const index = items.findIndex(
      (item, itemIndex) => getItemKey(item, itemIndex) === scrollToKey
    );
    if (index === -1) {
      return;
    }
    scrolledKeyRef.current = {
      key: scrollToKey,
      request: scrollToKeyRequest ?? scrollToKey,
    };
    if (shouldVirtualize) {
      if (scrollToKeyOffset === undefined) {
        rowVirtualizer.scrollToIndex(index, { align: "center" });
        return;
      }
      const estimatedOffset = items
        .slice(0, index)
        .reduce(
          (total, item, itemIndex) => total + estimateItemSize(item, itemIndex),
          0
        );
      const restoreAnchor = (): void => {
        const container = scrollContainerRef.current;
        if (container) {
          container.scrollTop = Math.max(
            0,
            estimatedOffset - (scrollToKeyOffset ?? 0)
          );
          container.dispatchEvent(new Event("scroll"));
        } else {
          rowVirtualizer.scrollToOffset(
            estimatedOffset - (scrollToKeyOffset ?? 0),
            { behavior: "auto" }
          );
        }
      };
      const frame = requestAnimationFrame(restoreAnchor);
      return () => cancelAnimationFrame(frame);
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
  }, [
    scrollToKey,
    scrollToKeyOffset,
    scrollToKeyRequest,
    shouldVirtualize,
    items.length,
  ]);

  useEffect(() => {
    if (scrollToKey === null) scrolledKeyRef.current = null;
  }, [scrollToKey]);

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
            data-scroll-key={getItemKey(item, virtualRow.index)}
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
