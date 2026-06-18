import React from "react";

interface DropdownHiddenToggleProps {
  /** Number of currently-hidden options. The button is disabled when 0. */
  hiddenCount: number;
  /** Whether the hidden section is currently expanded. */
  showHidden: boolean;
  /** Toggle the hidden section open/closed. */
  onToggle: () => void;
  /**
   * Which edge carries the divider line separating the bar from the list.
   * "top" (default) for a footer bar rendered below the list; "bottom" for a
   * header bar rendered above an upward-opening list (MultiCheckboxDropdown).
   */
  dividerSide?: "top" | "bottom";
}

/**
 * DropdownHiddenToggle — the "Show hidden (N)" / "Hide hidden" footer bar shared
 * by every hideable select dropdown (CustomSelect, SkillsSelect,
 * MultiCheckboxDropdown, HarnessDropdown).
 *
 * Single source for the bar's markup and label logic so the four selects stay
 * visually and behaviourally identical.
 */
export const DropdownHiddenToggle: React.FC<DropdownHiddenToggleProps> = ({
  hiddenCount,
  showHidden,
  onToggle,
  dividerSide = "top",
}) => (
  <div
    className={`${dividerSide === "bottom" ? "border-b" : "border-t"} border-dropdown-border bg-editor-bg flex-shrink-0`}
  >
    <button
      type="button"
      disabled={hiddenCount === 0}
      onClick={onToggle}
      className="w-full px-2 py-1.5 text-xs text-center text-description-fg disabled:opacity-40 hover:enabled:bg-list-hover-bg focus:outline-none border-none bg-transparent transition-colors"
    >
      {showHidden
        ? "Hide hidden"
        : hiddenCount > 0
          ? `Show hidden (${hiddenCount})`
          : "Show hidden"}
    </button>
  </div>
);
