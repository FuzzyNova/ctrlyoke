interface Tab {
  id: string;
  label: string;
  icon: string;
  indicator?: boolean;
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
          title={tab.label}
          className={`flex items-center gap-2 py-2 text-sm text-left w-full
            border-l-2 transition-colors
            ${iconOnly ? "justify-center px-0" : "px-3"}
            ${
              activeTab === tab.id
                ? "border-focus-border text-foreground bg-list-active-bg"
                : "border-transparent text-description-fg hover:text-foreground hover:bg-list-hover-bg"
            }`}
        >
          <span className="relative shrink-0">
            <span className={`codicon ${tab.icon} text-base`} />
            {tab.indicator && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-indicator-success" />
            )}
          </span>
          {!iconOnly && <span>{tab.label}</span>}
        </button>
      ))}
    </div>
  );
}
