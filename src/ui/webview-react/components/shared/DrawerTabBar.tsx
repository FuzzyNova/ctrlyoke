import React from "react";
import { DRAWER_TABS, type DrawerPage } from "../../types/drawerPages";
import { HarnessIcon } from "./HarnessIcon";
import type { HarnessId } from "../../types/messages";
import type { TabIconOverride } from "./tabBadgeUtils";

interface DrawerTabBarProps {
  activeTab: DrawerPage;
  onTabChange: (id: DrawerPage) => void;
  /** Active harness ID — renders HarnessIcon on the Harness tab instead of a codicon */
  harnessId: HarnessId;
  /** Whether the drawer is narrow — retained for parent compatibility */
  isNarrow: boolean;
  /** Per-tab icon/color overrides driven by resolved property state */
  tabOverrides?: Partial<Record<DrawerPage, TabIconOverride>>;
}

export const DrawerTabBar: React.FC<DrawerTabBarProps> = ({
  activeTab,
  onTabChange,
  harnessId,
  tabOverrides,
}) => {
  return (
    <div className="flex items-center border-t border-panel-border bg-sidebar-bg">
      {DRAWER_TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        const override = tabOverrides?.[tab.id];
        const codicon = override?.codicon ?? tab.codicon;
        const overrideColor = !isActive ? override?.color : undefined;
        const inactiveColor = overrideColor ?? "text-description-fg";
        const hoverClass = !isActive
          ? (override?.hoverColor ?? "hover:text-foreground")
          : "";
        return (
          <button
            key={tab.id}
            type="button"
            title={tab.label}
            className={`flex-1 flex items-center justify-center py-1.5 transition-colors cursor-pointer border-b-2 ${
              isActive
                ? "border-focus-border text-foreground"
                : `border-transparent ${inactiveColor} ${hoverClass}${tab.placeholder ? " opacity-60" : ""}`
            }`}
            onClick={() => onTabChange(tab.id)}
          >
            {codicon ? (
              <span
                className={`codicon codicon-${codicon}`}
                style={{ fontSize: 16 }}
              />
            ) : (
              <HarnessIcon harnessId={harnessId} size={18} />
            )}
          </button>
        );
      })}
    </div>
  );
};
