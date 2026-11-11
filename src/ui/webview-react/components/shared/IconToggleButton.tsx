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
  /** Icon size class; defaults to the toolbar's large codicon. */
  iconClassName?: string;
}> = ({
  active,
  onToggle,
  activeIcon,
  inactiveIcon,
  activeTooltip,
  inactiveTooltip,
  ariaLabel,
  iconClassName = "codicon-lg",
}) => {
  const icon = (
    <Icon name={active ? activeIcon : inactiveIcon} className={iconClassName} />
  );

  return (
    <button
      type="button"
      onClick={() => onToggle(!active)}
      title={active ? activeTooltip : inactiveTooltip}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`control-button flex shrink-0 items-center gap-1 px-1 bg-transparent border-none cursor-pointer leading-none touch-manipulation transition-colors cy-no-select ${
        active
          ? "text-widget-highlight-fg hover:text-widget-highlight-fg-hover"
          : "text-description-fg hover:text-foreground"
      }`}
    >
      {icon}
    </button>
  );
};
