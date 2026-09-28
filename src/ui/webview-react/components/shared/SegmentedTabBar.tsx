import React from "react";
import { HarnessIcon } from "./HarnessIcon";
import type { HarnessId } from "../../types/messages";
import type { TabIconOverride } from "./tabBadgeUtils";
import { Icon } from "./Icon";

export interface SegmentedTab<Id extends string> {
  id: Id;
  label: string;
  /** Codicon name. Omit for the Harness tab, which uses HarnessIcon. */
  codicon?: string;
  /** Tab is visible but shows "Coming Soon" placeholder content. */
  placeholder?: boolean;
}

export interface SegmentedTabBarProps<Id extends string> {
  tabs: readonly SegmentedTab<Id>[];
  activeTab: Id;
  onTabChange: (id: Id) => void;
  /** Accessible name for this tablist. */
  ariaLabel: string;
  /** Active harness ID for tabs without a codicon. */
  harnessId?: HarnessId;
  /** Per-tab icon/color overrides driven by resolved property state. */
  tabOverrides?: Partial<Record<Id, TabIconOverride>>;
  /** Per-tab settings search match counts; undefined means search is inactive. */
  matchCount?: Partial<Record<Id, number>>;
  /** Override the wrapper div className. */
  className?: string;
}

export function SegmentedTabBar<Id extends string>({
  tabs,
  activeTab,
  onTabChange,
  ariaLabel,
  harnessId,
  tabOverrides,
  matchCount,
  className,
}: SegmentedTabBarProps<Id>): React.ReactElement {
  return (
    <div
      className={
        className ??
        "flex items-center border-t border-panel-border bg-sidebar-bg overflow-x-hidden h-10"
      }
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const override = tabOverrides?.[tab.id];
        const count = matchCount?.[tab.id];
        const accessibleLabel =
          count === undefined ? tab.label : `${tab.label}, ${count} matches`;
        const codicon = override?.codicon ?? tab.codicon;
        const overrideColor = !isActive ? override?.color : undefined;
        const inactiveColor = overrideColor ?? "text-description-fg";
        const activeColor = override?.activeColor ?? "text-foreground";
        const hoverClass = !isActive
          ? (override?.hoverColor ?? "hover:text-foreground") +
            " hover:border-b-panel-border"
          : "";

        return (
          <button
            key={tab.id}
            type="button"
            title={accessibleLabel}
            aria-label={accessibleLabel}
            role="tab"
            aria-selected={isActive}
            className={`cy-tab-hc${isActive ? " cy-tab-hc-selected" : ""} relative flex-1 flex items-center justify-center py-2 transition-colors cursor-pointer border-b-2 ${
              isActive
                ? `border-b-focus-border ${activeColor}`
                : `border-b-transparent ${inactiveColor} ${hoverClass}${tab.placeholder ? " opacity-60" : ""}`
            }${count === 0 ? " opacity-40" : ""}`}
            onClick={() => onTabChange(tab.id)}
          >
            {codicon ? (
              <span className="relative inline-flex">
                <Icon name={codicon} style={{ fontSize: 20 }} />
                {override?.badgeCodicon ? (
                  <span
                    aria-hidden="true"
                    className="absolute -bottom-1 -right-1 flex h-[13px] w-[13px] items-center justify-center rounded-full bg-sidebar-bg"
                  >
                    <Icon
                      name={override.badgeCodicon}
                      className={override.badgeColor ?? ""}
                      style={{ fontSize: 11 }}
                    />
                  </span>
                ) : null}
              </span>
            ) : harnessId ? (
              <HarnessIcon
                harnessId={harnessId}
                size={20}
                className={
                  isActive ? "opacity-100" : "opacity-80 hover:opacity-100"
                }
              />
            ) : (
              <Icon name="robot" style={{ fontSize: 20 }} />
            )}
            {count !== undefined && (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-badge-bg px-1 text-[9px] leading-none text-badge-fg"
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
