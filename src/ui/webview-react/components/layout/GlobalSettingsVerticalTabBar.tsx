import { useEffect, useRef } from "react";
import { Icon } from "../shared/Icon";
import { LucideIcon } from "../shared/LucideIcon";
import { ScrollOverflowRail } from "../shared/ScrollOverflowRail";
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

export function GlobalSettingsVerticalTabBar({
  tabs,
  activeTab,
  onTabChange,
  iconOnly = false,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Selecting a tab from search results or the keyboard can pick one that is
  // scrolled out of view; bring it back so the selection is visible.
  // Only the rail's own scroller moves. `scrollIntoView` would also scroll
  // every ancestor, and on mount the drawer is still parked off-screen at
  // translate-y-full, so it scrolled the dashboard's overflow-hidden
  // container to "reveal" the tab. That scroll outlived the slide-in and left
  // the whole drawer shifted up, its title bar cut off and a gap below.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const tab = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-tab-id]")
    ).find((element) => element.dataset.tabId === activeTab);
    if (!tab) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    if (tabRect.top < scrollerRect.top) {
      scroller.scrollTop -= scrollerRect.top - tabRect.top;
    } else if (tabRect.bottom > scrollerRect.bottom) {
      scroller.scrollTop += tabRect.bottom - scrollerRect.bottom;
    }
  }, [activeTab]);

  // The native scrollbar is hidden: in the 40px icon-only rail it took its
  // width from inside the rail and squeezed the icons off-centre. The edge
  // chevrons stand in for it as the "more tabs this way" cue.
  return (
    <ScrollOverflowRail
      className={`border-r border-panel-border bg-sidebar-bg shrink-0 ${iconOnly ? "w-11" : "w-44"}`}
      contentClassName="flex flex-col py-2"
      scrollUpLabel="Scroll tabs up"
      scrollDownLabel="Scroll tabs down"
      scrollerRef={scrollerRef}
      scrollerTestId="settings-tab-rail-scroller"
    >
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
          className={`flex items-center gap-2 text-sm text-left w-full
            border-l-2 transition-colors touch-manipulation
            ${iconOnly ? "justify-center px-0 py-2.5" : "px-3 py-2"}
            ${tab.matchCount === 0 ? "opacity-40" : ""}
            ${
              activeTab === tab.id
                ? "border-focus-border text-foreground bg-list-active-bg"
                : "border-transparent text-description-fg hover:text-foreground hover:bg-list-hover-bg"
            }`}
        >
          <span className="relative shrink-0">
            {typeof tab.icon === "string" ? (
              <Icon
                name={tab.icon}
                className={iconOnly ? "codicon-lg" : "text-base"}
              />
            ) : (
              <LucideIcon icon={tab.icon} size={iconOnly ? "lg" : "md"} />
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
    </ScrollOverflowRail>
  );
}
