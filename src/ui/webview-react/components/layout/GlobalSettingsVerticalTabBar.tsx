import { useCallback, useEffect, useRef } from "react";
import { useScrollOverflowEdges } from "@hooks/useScrollOverflowEdges";
import { Icon } from "../shared/Icon";
import { LucideIcon } from "../shared/LucideIcon";
import type { SettingsTab } from "../settings/settingsTabs";
interface Tab extends SettingsTab {
  indicator?: boolean;
  matchCount?: number;
}

interface Props {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  iconOnly?: boolean;
}

/** Fraction of the rail's visible height one chevron click scrolls. */
const CHEVRON_SCROLL_FRACTION = 0.75;

/** Scroll direction along the rail: -1 toward the top, 1 toward the bottom. */
type ScrollDirection = 1 | -1;

interface ScrollChevronProps {
  direction: ScrollDirection;
  onScroll: (direction: ScrollDirection) => void;
}

/**
 * Edge fade with a chevron, shown in place of the rail's hidden scrollbar
 * while more tabs sit past that edge. Not in the tab order: keyboard focus
 * moving onto an offscreen tab scrolls it into view natively.
 */
function ScrollChevron({ direction, onScroll }: ScrollChevronProps) {
  const isUp = direction < 0;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={isUp ? "Scroll tabs up" : "Scroll tabs down"}
      onClick={() => onScroll(direction)}
      className={`absolute inset-x-0 z-10 flex h-6 justify-center text-description-fg hover:text-foreground
        ${isUp ? "top-0 items-start bg-linear-to-b" : "bottom-0 items-end bg-linear-to-t"}
        from-sidebar-bg from-40% to-transparent`}
    >
      <Icon name={isUp ? "chevron-up" : "chevron-down"} />
    </button>
  );
}

export function GlobalSettingsVerticalTabBar({
  tabs,
  activeTab,
  onTabChange,
  iconOnly = false,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [edgesRef, { canScrollUp, canScrollDown }] = useScrollOverflowEdges();
  const mergedScrollerRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node;
      edgesRef(node);
    },
    [edgesRef]
  );

  // Selecting a tab from search results or the keyboard can pick one that is
  // scrolled out of view; bring it back so the selection is visible.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    Array.from(scroller.querySelectorAll<HTMLElement>("[data-tab-id]"))
      .find((element) => element.dataset.tabId === activeTab)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeTab]);

  const scrollByPage = (direction: ScrollDirection) => {
    const scroller = scrollerRef.current;
    scroller?.scrollBy({
      top: direction * scroller.clientHeight * CHEVRON_SCROLL_FRACTION,
      behavior: "smooth",
    });
  };

  // The native scrollbar is hidden: in the 40px icon-only rail it took its
  // width from inside the rail and squeezed the icons off-centre. The edge
  // chevrons stand in for it as the "more tabs this way" cue.
  return (
    <div
      className={`relative flex flex-col min-h-0 border-r border-panel-border bg-sidebar-bg shrink-0 ${iconOnly ? "w-10" : "w-44"}`}
    >
      {canScrollUp && <ScrollChevron direction={-1} onScroll={scrollByPage} />}
      <div
        ref={mergedScrollerRef}
        data-testid="settings-tab-rail-scroller"
        className="flex-1 min-h-0 overflow-y-auto scrollbar-hide"
      >
        <div className="flex flex-col py-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              data-tab-id={tab.id}
              onClick={() => onTabChange(tab.id)}
              title={
                tab.matchCount === undefined
                  ? tab.label
                  : `${tab.label}, ${tab.matchCount} matches`
              }
              aria-label={
                tab.matchCount === undefined
                  ? tab.label
                  : `${tab.label}, ${tab.matchCount} matches`
              }
              className={`flex items-center gap-2 py-2 text-sm text-left w-full
            border-l-2 transition-colors
            ${iconOnly ? "justify-center px-0" : "px-3"}
            ${tab.matchCount === 0 ? "opacity-40" : ""}
            ${
              activeTab === tab.id
                ? "border-focus-border text-foreground bg-list-active-bg"
                : "border-transparent text-description-fg hover:text-foreground hover:bg-list-hover-bg"
            }`}
            >
              <span className="relative shrink-0">
                {typeof tab.icon === "string" ? (
                  <Icon name={tab.icon} className="text-base" />
                ) : (
                  <LucideIcon icon={tab.icon} />
                )}
                {iconOnly && tab.matchCount !== undefined ? (
                  <span className="absolute -right-2 -top-2 flex min-w-4 h-4 items-center justify-center rounded-full bg-badge-bg px-1 text-[9px] leading-none text-badge-fg">
                    {tab.matchCount}
                  </span>
                ) : tab.indicator ? (
                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-indicator-success" />
                ) : null}
              </span>
              {!iconOnly && <span className="min-w-0 flex-1">{tab.label}</span>}
              {!iconOnly && tab.matchCount !== undefined && (
                <span className="rounded-full bg-badge-bg px-1.5 py-0.5 text-[10px] leading-none text-badge-fg tabular-nums">
                  {tab.matchCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      {canScrollDown && <ScrollChevron direction={1} onScroll={scrollByPage} />}
    </div>
  );
}
