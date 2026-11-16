import { useCallback, useRef, type ReactNode, type RefObject } from "react";
import { useScrollOverflowEdges } from "@hooks/useScrollOverflowEdges";
import { Icon } from "./Icon";

/** Fraction of the rail's visible height one chevron click scrolls. */
const CHEVRON_SCROLL_FRACTION = 0.75;

/** Scroll direction along the rail: -1 toward the top, 1 toward the bottom. */
type ScrollDirection = 1 | -1;

interface ScrollChevronProps {
  direction: ScrollDirection;
  label: string;
  onScroll: (direction: ScrollDirection) => void;
}

/**
 * Edge fade with a chevron, shown in place of the rail's hidden scrollbar
 * while more items sit past that edge. Not in the tab order: keyboard focus
 * moving onto an offscreen item scrolls it into view natively.
 */
function ScrollChevron({ direction, label, onScroll }: ScrollChevronProps) {
  const isUp = direction < 0;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      onClick={() => onScroll(direction)}
      className={`absolute inset-x-0 z-10 flex h-6 justify-center text-description-fg hover:text-foreground
        ${isUp ? "top-0 items-start bg-linear-to-b" : "bottom-0 items-end bg-linear-to-t"}
        from-sidebar-bg from-40% to-transparent`}
    >
      <Icon name={isUp ? "chevron-up" : "chevron-down"} />
    </button>
  );
}

interface ScrollOverflowRailProps {
  /** Classes for the outer, non-scrolling frame (sizing, border, background). */
  className?: string;
  /** Classes for the single content wrapper inside the scroller. */
  contentClassName?: string;
  /**
   * When true (default) the native scrollbar is hidden and edge chevrons stand
   * in for it. Narrow rails need this: a native scrollbar takes its width from
   * inside the rail and squeezes or overlaps the centred items.
   */
  chevrons?: boolean;
  /** Accessible names for the chevrons, e.g. "Scroll tabs up". */
  scrollUpLabel: string;
  scrollDownLabel: string;
  /** Optional handle on the scroll container, for callers that scroll it. */
  scrollerRef?: RefObject<HTMLDivElement | null>;
  scrollerTestId?: string;
  children: ReactNode;
}

/**
 * Vertical rail whose overflow is signalled by top/bottom chevrons instead of
 * a scrollbar. The chevron fade blends into `bg-sidebar-bg`, so give the rail
 * that background.
 */
export function ScrollOverflowRail({
  className = "",
  contentClassName = "",
  chevrons = true,
  scrollUpLabel,
  scrollDownLabel,
  scrollerRef: externalScrollerRef,
  scrollerTestId,
  children,
}: ScrollOverflowRailProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [edgesRef, { canScrollUp, canScrollDown }] = useScrollOverflowEdges();
  const mergedScrollerRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node;
      if (externalScrollerRef) externalScrollerRef.current = node;
      edgesRef(node);
    },
    [edgesRef, externalScrollerRef]
  );

  const scrollByPage = (direction: ScrollDirection) => {
    const scroller = scrollerRef.current;
    scroller?.scrollBy({
      top: direction * scroller.clientHeight * CHEVRON_SCROLL_FRACTION,
      behavior: "smooth",
    });
  };

  return (
    <div className={`relative flex flex-col min-h-0 ${className}`}>
      {chevrons && canScrollUp && (
        <ScrollChevron
          direction={-1}
          label={scrollUpLabel}
          onScroll={scrollByPage}
        />
      )}
      <div
        ref={mergedScrollerRef}
        data-testid={scrollerTestId}
        className={`flex-1 min-h-0 overflow-y-auto ${chevrons ? "scrollbar-hide" : ""}`}
      >
        {/* Single wrapper: useScrollOverflowEdges observes the scroller's
            first child to notice content growing without a viewport resize. */}
        <div className={contentClassName}>{children}</div>
      </div>
      {chevrons && canScrollDown && (
        <ScrollChevron
          direction={1}
          label={scrollDownLabel}
          onScroll={scrollByPage}
        />
      )}
    </div>
  );
}
