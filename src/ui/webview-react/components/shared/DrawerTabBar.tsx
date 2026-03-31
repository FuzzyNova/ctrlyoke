import React from "react";
import { DRAWER_TABS, type DrawerPage } from "../../types/drawerPages";
import { HarnessIcon } from "./HarnessIcon";
import type { HarnessId } from "../../types/messages";

interface DrawerTabBarProps {
  activeTab: DrawerPage;
  onTabChange: (id: DrawerPage) => void;
  /** Active harness ID — renders HarnessIcon on the Harness tab instead of a codicon */
  harnessId: HarnessId;
  /** Whether the drawer is narrow — hides labels and shows icons only when true */
  isNarrow: boolean;
}

export const DrawerTabBar: React.FC<DrawerTabBarProps> = ({
  activeTab,
  onTabChange,
  harnessId,
  isNarrow,
}) => {
  return (
    <div className="flex items-center border-t border-panel-border bg-sidebar-bg">
      {DRAWER_TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            title={isNarrow ? tab.label : undefined}
            className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[10px] font-medium transition-colors cursor-pointer border-b-2 ${
              isActive
                ? "border-focus-border text-foreground"
                : `border-transparent text-description-fg hover:text-foreground${tab.placeholder ? " opacity-60" : ""}`
            }`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.codicon ? (
              <span
                className={`codicon codicon-${tab.codicon}`}
                style={{ fontSize: 12 }}
              />
            ) : (
              <HarnessIcon harnessId={harnessId} size={14} />
            )}
            {!isNarrow && tab.label}
          </button>
        );
      })}
    </div>
  );
};
