import React, { useEffect, useRef } from "react";
import type { RefObject } from "react";
import {
  useVirtualizedListFoundation,
  type VirtualizedListRange,
} from "./VirtualizedListFoundation";

const DEFAULT_PAGED_ROW_HEIGHT = 36;
const DEFAULT_PAGED_OVERSCAN = 12;

export interface VirtualizedPagedListProps<T> {
  /** Total rows in the immutable listing, including rows not loaded locally. */
  totalCount: number;
  /** Identifies the listing so placeholder keys cannot survive a new listing. */
  listingId: string;
  /** O(1) sparse lookup by absolute virtual index. */
  getItem: (index: number) => T | undefined;
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
  renderPlaceholder: (index: number) => React.ReactNode;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  estimateItemSize?: (index: number) => number;
  overscan?: number;
  /** Set to a positive value to render small listings densely. */
  threshold?: number;
  onRangeChange?: (range: VirtualizedListRange) => void;
  layoutResetKey?: string | number;
  /** Scrolls once to an absolute row index, even before that row is loaded. */
  scrollToIndex?: number | null;
  /** Keeps the target row this many pixels below the viewport top. */
  scrollToIndexOffset?: number;
  /** Optional identity for intentionally repeating the same scroll request. */
  scrollToIndexRequest?: string | number;
}

function placeholderKey(listingId: string, index: number): string {
  return `virtualized-placeholder:${listingId}:${index}`;
}

/**
 * Sparse-list counterpart to VirtualizedList. The TanStack setup is shared
 * with dense lists; only absolute-index lookup and placeholder rendering are
 * specific to paged data sources.
 */
export function VirtualizedPagedList<T>({
  totalCount,
  listingId,
  getItem,
  getItemKey,
  renderItem,
  renderPlaceholder,
  scrollContainerRef,
  estimateItemSize = () => DEFAULT_PAGED_ROW_HEIGHT,
  overscan = DEFAULT_PAGED_OVERSCAN,
  threshold = 0,
  onRangeChange,
  layoutResetKey,
  scrollToIndex = null,
  scrollToIndexOffset,
  scrollToIndexRequest,
}: VirtualizedPagedListProps<T>): React.ReactElement {
  const count = Math.max(0, Math.floor(totalCount));
  const shouldVirtualize = count >= threshold;
  const { rowVirtualizer } = useVirtualizedListFoundation({
    count,
    scrollContainerRef,
    estimateSize: estimateItemSize,
    overscan,
    layoutResetKey,
    rangeNotificationKey: listingId,
    onRangeChange,
    getItemKey: (index) => {
      const item = getItem(index);
      return item === undefined
        ? placeholderKey(listingId, index)
        : getItemKey(item, index);
    },
  });

  const scrollTargetRef = useRef<{
    index: number;
    request: string | number;
  } | null>(null);
  useEffect(() => {
    if (scrollToIndex === null) {
      scrollTargetRef.current = null;
      return;
    }
    if (scrollToIndex < 0 || scrollToIndex >= count) return;

    const request = scrollToIndexRequest ?? listingId;
    if (
      scrollTargetRef.current?.index === scrollToIndex &&
      scrollTargetRef.current.request === request
    ) {
      return;
    }
    scrollTargetRef.current = { index: scrollToIndex, request };

    if (!shouldVirtualize) {
      const row = scrollContainerRef.current?.querySelector(
        `[data-index="${scrollToIndex}"]`
      );
      row?.scrollIntoView?.({ block: "nearest" });
      return;
    }

    const jumpToIndex = (): void => {
      rowVirtualizer.scrollToIndex(scrollToIndex, {
        align: scrollToIndexOffset === undefined ? "center" : "start",
        behavior: "auto",
      });
      const container = scrollContainerRef.current;
      // The normal TanStack path uses measured offsets. A parent-owned ref can
      // still be between attachment and observation for one frame, so retain
      // an O(1) estimate fallback for an absolute jump rather than silently
      // leaving a far target at the top.
      if (container && scrollToIndex > 0 && container.scrollTop === 0) {
        const rowSize = Math.max(1, estimateItemSize(scrollToIndex));
        const alignmentOffset =
          scrollToIndexOffset ??
          Math.max(0, (container.offsetHeight - rowSize) / 2);
        container.scrollTop = Math.max(
          0,
          scrollToIndex * rowSize - alignmentOffset
        );
      }
      container?.dispatchEvent(new Event("scroll"));
    };
    jumpToIndex();

    // TanStack may need a frame to resolve a far target's estimated offset.
    // Repeating the absolute-index jump after mount also covers a parent ref
    // that was attached between the virtualizer's layout effects. Correct the
    // optional viewport anchor without summing the sparse list.
    const frame = requestAnimationFrame(() => {
      jumpToIndex();
      if (scrollToIndexOffset === undefined) return;
      const container = scrollContainerRef.current;
      if (!container) return;
      container.scrollTop = Math.max(
        0,
        container.scrollTop - scrollToIndexOffset
      );
      container.dispatchEvent(new Event("scroll"));
    });
    return () => cancelAnimationFrame(frame);
  }, [
    count,
    estimateItemSize,
    listingId,
    rowVirtualizer,
    scrollContainerRef,
    scrollToIndex,
    scrollToIndexOffset,
    scrollToIndexRequest,
    shouldVirtualize,
  ]);

  if (!shouldVirtualize) {
    return (
      <>
        {Array.from({ length: count }, (_unused, index) => {
          const item = getItem(index);
          const key =
            item === undefined
              ? placeholderKey(listingId, index)
              : getItemKey(item, index);
          return (
            <React.Fragment key={key}>
              {item === undefined
                ? renderPlaceholder(index)
                : renderItem(item, index)}
            </React.Fragment>
          );
        })}
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
        const item = getItem(virtualRow.index);
        const isPlaceholder = item === undefined;
        const estimatedSize = Math.max(1, estimateItemSize(virtualRow.index));
        return (
          <div
            key={virtualRow.key}
            ref={rowVirtualizer.measureElement}
            data-index={virtualRow.index}
            data-virtual-placeholder={isPlaceholder ? "true" : undefined}
            style={{
              minHeight: `${estimatedSize}px`,
              position: "absolute",
              top: virtualRow.start,
              left: 0,
              width: "100%",
            }}
          >
            {isPlaceholder
              ? renderPlaceholder(virtualRow.index)
              : renderItem(item, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );
}
