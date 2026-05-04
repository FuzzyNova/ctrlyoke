import React from "react";

/**
 * Icon-only toggle button that functions like a checkbox.
 * Shows different icons and tooltips for active vs inactive states.
 * No border, no background - just the icon with hover and active color states.
 * Optional activeLabel/inactiveLabel show text next to the icon when not in narrow view.
 * labelPosition controls whether the text appears before ("left") or after ("right") the icon.
 *
 * When both labels are provided the button reserves width for the longer label so that
 * toggling between states does not cause layout shift in the parent container.
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
  labelPosition?: "left" | "right";
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
  labelPosition = "right",
}) => {
  const label = active ? activeLabel : inactiveLabel;

  // Render the longer label as invisible text to hold a stable width, then
  // overlay the active label absolutely. This prevents layout shift when
  // switching between labels of different lengths.
  const longerLabel =
    (activeLabel?.length ?? 0) >= (inactiveLabel?.length ?? 0)
      ? activeLabel
      : inactiveLabel;

  const text = !narrow && longerLabel && (
    <span className="relative inline-block">
      {/* Invisible spacer — always the longer label's width */}
      <span className="invisible text-xxs font-medium" aria-hidden="true">
        {longerLabel}
      </span>
      {/* Visible label — absolutely positioned, right-aligned */}
      <span className="absolute inset-0 flex items-center justify-end text-xxs font-medium">
        {label}
      </span>
    </span>
  );

  const icon = (
    <i
      className={`codicon codicon-lg codicon-${active ? activeIcon : inactiveIcon}`}
    />
  );

  return (
    <button
      onClick={() => onToggle(!active)}
      title={active ? activeTooltip : inactiveTooltip}
      aria-pressed={active}
      className={`control-button flex items-center gap-1 px-1 bg-transparent border-none cursor-pointer leading-none transition-colors ${
        active ? "text-link-fg" : "text-description-fg hover:text-foreground"
      }`}
    >
      {labelPosition === "left" ? (
        <>
          {text}
          {icon}
        </>
      ) : (
        <>
          {icon}
          {text}
        </>
      )}
    </button>
  );
};
