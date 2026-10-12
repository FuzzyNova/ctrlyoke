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

export function GlobalSettingsVerticalTabBar({
  tabs,
  activeTab,
  onTabChange,
  iconOnly = false,
}: Props) {
  return (
    <div
      className={`flex flex-col border-r border-panel-border bg-sidebar-bg shrink-0 overflow-y-auto py-2 ${iconOnly ? "w-10" : "w-44"}`}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
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
  );
}
