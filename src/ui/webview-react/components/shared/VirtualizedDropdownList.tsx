import React from "react";
import type { RefObject } from "react";
import { VirtualizedList } from "./VirtualizedList";

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
 * Thin dropdown-specific wrapper around the shared measured-list primitive.
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
  return (
    <VirtualizedList
      items={items}
      getItemKey={getItemKey}
      renderItem={renderItem}
      scrollContainerRef={scrollContainerRef}
      estimateItemSize={() => estimatedRowHeight}
      threshold={threshold}
      overscan={overscan}
      scrollToKey={scrollToKey}
    />
  );
}
