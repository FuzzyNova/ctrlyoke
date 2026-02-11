import React from "react";

/**
 * Icon-only toggle button that functions like a checkbox.
 * Shows different icons and tooltips for active vs inactive states.
 * No border, no background - just the icon with hover and active color states.
 */
export const IconToggleButton: React.FC<{
  active: boolean;
  onToggle: (active: boolean) => void;
  activeIcon: string;
  inactiveIcon: string;
  activeTooltip: string;
  inactiveTooltip: string;
}> = ({
  active,
  onToggle,
  activeIcon,
  inactiveIcon,
  activeTooltip,
  inactiveTooltip,
}) => (
  <button
    onClick={() => onToggle(!active)}
    title={active ? activeTooltip : inactiveTooltip}
    className={`p-1 bg-transparent border-none cursor-pointer text-[16px] leading-none transition-colors ${
      active
        ? "text-[var(--vscode-textLink-foreground)]"
        : "text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]"
    }`}
  >
    <i className={`codicon codicon-${active ? activeIcon : inactiveIcon}`} />
  </button>
);
