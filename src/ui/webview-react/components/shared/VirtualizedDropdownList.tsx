import React from "react";
import type { RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

// Below this count, rows render directly — cheap enough that virtualization's
// own overhead (scroll container measurement, absolute-positioned wrappers)
// isn't worth it, and it keeps the DOM structure predictable for small lists
// (existing tests are built around small fixture lists). At/above it — a long
// recent-workflow history or many simultaneously running workflows — mounting
// every row on each open is what blocks the main thread and starves the
// dropdown's open/close animation of frames, so only the rows scrolled into
// view get mounted.
export const DROPDOWN_LIST_VIRTUALIZATION_THRESHOLD = 50;
const DEFAULT_ROW_ESTIMATED_HEIGHT = 36;
const DEFAULT_ROW_OVERSCAN = 12;

interface VirtualizedDropdownListProps<T> {
  items: T[];
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  estimatedRowHeight?: number;
  overscan?: number;
  threshold?: number;
}

/**
 * Renders a flat list of dropdown rows directly below `threshold`, and via
 * `@tanstack/react-virtual` at/above it — same virtualization approach as
 * `useOutputVirtualization`, sized down for simple fixed-height dropdown rows
 * (no dynamic bucket estimation needed here, rows don't wrap).
 */
export function VirtualizedDropdownList<T>({
  items,
  getItemKey,
  renderItem,
  scrollContainerRef,
  estimatedRowHeight = DEFAULT_ROW_ESTIMATED_HEIGHT,
  overscan = DEFAULT_ROW_OVERSCAN,
  threshold = DROPDOWN_LIST_VIRTUALIZATION_THRESHOLD,
}: VirtualizedDropdownListProps<T>): React.ReactElement {
  const shouldVirtualize = items.length >= threshold;

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan,
    getItemKey: (index) => getItemKey(items[index], index) ?? index,
  });

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
        const item = items[virtualRow.index];
        if (!item) return null;

        return (
          <div
            key={virtualRow.key}
            ref={rowVirtualizer.measureElement}
            data-index={virtualRow.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {renderItem(item, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );
}
