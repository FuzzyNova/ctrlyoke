interface Tab {
  id: string;
  label: string;
  icon: string;
}

interface Props {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export function GlobalSettingsVerticalTabBar({ tabs, activeTab, onTabChange }: Props) {
  return (
    <div className="flex flex-col w-44 border-r border-panel-border bg-sidebar-bg shrink-0 overflow-y-auto py-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`flex items-center gap-2 px-3 py-2 text-sm text-left w-full
            border-l-2 transition-colors
            ${activeTab === tab.id
              ? "border-focus-border text-foreground bg-list-active-bg"
              : "border-transparent text-description-fg hover:text-foreground hover:bg-list-hover-bg"
            }`}
        >
          <span className={`codicon ${tab.icon} text-base shrink-0`} />
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
