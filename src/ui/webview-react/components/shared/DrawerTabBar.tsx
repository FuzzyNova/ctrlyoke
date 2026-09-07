import React from "react";
import { DRAWER_TABS, type DrawerPage } from "../../types/drawerPages";
import type { HarnessId } from "../../types/messages";
import type { TabIconOverride } from "./tabBadgeUtils";
import { SegmentedTabBar } from "./SegmentedTabBar";

interface DrawerTabBarProps {
  activeTab: DrawerPage;
  onTabChange: (id: DrawerPage) => void;
  /** Accessible name for this tablist. */
  ariaLabel: string;
  /**
   * Active harness ID — renders HarnessIcon on the Harness tab instead of a codicon.
   * When omitted, the Harness tab falls back to `codicon-robot`.
   */
  harnessId?: HarnessId;
  /** Whether the drawer is narrow — retained for parent compatibility */
  isNarrow: boolean;
  /** Per-tab icon/color overrides driven by resolved property state */
  tabOverrides?: Partial<Record<DrawerPage, TabIconOverride>>;
  /** Override the wrapper div className (default includes border-t and bg-sidebar-bg) */
  className?: string;
}

export const DrawerTabBar: React.FC<DrawerTabBarProps> = ({
  activeTab,
  onTabChange,
  ariaLabel,
  harnessId,
  tabOverrides,
  className,
}) => {
  return (
    <SegmentedTabBar<DrawerPage>
      tabs={DRAWER_TABS}
      activeTab={activeTab}
      onTabChange={onTabChange}
      ariaLabel={ariaLabel}
      harnessId={harnessId}
      tabOverrides={tabOverrides}
      className={className}
    />
  );
};
