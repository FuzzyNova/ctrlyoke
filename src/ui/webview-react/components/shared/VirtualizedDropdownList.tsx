import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
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
const DROPDOWN_LIST_VIRTUALIZATION_THRESHOLD = 50;
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
  /**
   * Scrolls the matching row into view once, the first time it resolves to an
   * index (mount, or a later arrival e.g. after an async fetch populates
   * `items`). Re-fires if the key itself changes (new panel content), but not
   * on every render — callers don't need to track "already scrolled" state.
   * Used by RunPanel to bring the viewed run into view without a layout
   * jump on every re-render.
   */
  scrollToKey?: string | null;
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
  scrollToKey = null,
}: VirtualizedDropdownListProps<T>): React.ReactElement {
  const shouldVirtualize = items.length >= threshold;

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan,
    getItemKey: (index) => getItemKey(items[index], index) ?? index,
  });

  // The scroll container is owned by the *parent* (WorkflowList, RunPanel …),
  // and React attaches a host element's ref only after its children's layout
  // effects have run. So during this component's own mount the virtualizer
  // resolves `getScrollElement()` to null, never observes the scroller, and
  // renders zero rows — with nothing scheduled to re-resolve it. On the app's
  // first mount unrelated store updates re-rendered the list and hid the
  // problem; a list remounted with already-final props — returning from the
  // run panel to the workflow list — got no such re-render and stayed
  // permanently blank. This one-shot state flip re-renders after mount (before
  // paint), when the parent's ref is attached, so the virtualizer resolves and
  // observes the real scroll element. Flipping an already-true value bails out,
  // so it costs exactly one extra render.
  const [, markScrollElementResolvable] = useState(false);
  useLayoutEffect(() => {
    markScrollElementResolvable(true);
  }, []);

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
    // items.length is tracked, so a target that resolves later (e.g. an
    // async summary fetch that hasn't landed yet on the first pass) still
    // gets scrolled to once its row actually appears.
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
