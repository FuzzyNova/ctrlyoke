import React from "react";

/**
 * Icon-only toggle button that functions like a checkbox.
 * Shows different icons and tooltips for active vs inactive states.
 * No border, no background - just the icon with hover and active color states.
 * Optional activeLabel/inactiveLabel show text to the right of the icon when not in narrow view.
 */
export const IconToggleButton: React.FC<{
  active: boolean;
  onToggle: (active: boolean) => void;
  activeIcon: string;
  inactiveIcon: string;
  activeTooltip: string;
  inactiveTooltip: string;
  activeLabel?: string;
  inactiveLabel?: string;
  narrow?: boolean;
}> = ({
  active,
  onToggle,
  activeIcon,
  inactiveIcon,
  activeTooltip,
  inactiveTooltip,
  activeLabel,
  inactiveLabel,
  narrow = false,
}) => {
  const label = active ? activeLabel : inactiveLabel;
  return (
    <button
      onClick={() => onToggle(!active)}
      title={active ? activeTooltip : inactiveTooltip}
      className={`flex items-center gap-1 px-1 bg-transparent border-none cursor-pointer leading-none transition-colors ${
        active ? "text-link-fg" : "text-description-fg hover:text-foreground"
      }`}
    >
      <i
        className={`codicon codicon-lg codicon-${active ? activeIcon : inactiveIcon}`}
      />
      {!narrow && label && (
        <span className="text-[10px] font-medium">{label}</span>
      )}
    </button>
  );
};
