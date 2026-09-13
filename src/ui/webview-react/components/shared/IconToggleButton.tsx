import React from "react";
import { Icon } from "./Icon";

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
  ariaLabel: string;
}> = ({
  active,
  onToggle,
  activeIcon,
  inactiveIcon,
  activeTooltip,
  inactiveTooltip,
  ariaLabel,
}) => {
  const icon = (
    <Icon name={active ? activeIcon : inactiveIcon} className="codicon-lg" />
  );

  return (
    <button
      onClick={() => onToggle(!active)}
      title={active ? activeTooltip : inactiveTooltip}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`control-button flex items-center gap-1 px-1 bg-transparent border-none cursor-pointer leading-none transition-colors cy-no-select ${
        active
          ? "text-widget-highlight-fg hover:text-widget-highlight-fg-hover"
          : "text-description-fg hover:text-foreground"
      }`}
    >
      {icon}
    </button>
  );
};
