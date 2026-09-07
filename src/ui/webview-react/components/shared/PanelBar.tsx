import { KEYBOARD_KEYS } from "@root/types/DashboardConstants";
import React from "react";
import { Icon } from "./Icon";

interface PanelBarProps {
  /** Section title (shown in horizontal bars, hidden in vertical bars) */
  title: string;
  /** Codicon name without the "codicon-" prefix */
  icon: string;
  /** horizontal = thin strip (vertically-stacked panels like Output/Editor/Settings)
   *  vertical = thin column (side-by-side panels like Prompts) */
  orientation: "horizontal" | "vertical";
  /** Called when the bar is clicked to expand the panel */
  onClick: () => void;
}

/**
 * Thin bar rendered when a panel is collapsed — matches VS Code's
 * collapsed-section style (chevron + icon + optional title).
 */
export const PanelBar: React.FC<PanelBarProps> = ({
  title,
  icon,
  orientation,
  onClick,
}) => {
  if (orientation === "vertical") {
    // Thin vertical column: just chevron + icon, no title text
    return (
      <div
        className="flex flex-col justify-start items-center w-full h-full pt-1.5 gap-1 cursor-pointer select-none text-description-fg hover:text-foreground transition-colors"
        onClick={onClick}
        role="button"
        aria-label={`Expand ${title}`}
        tabIndex={0}
        onKeyDown={(e) => e.key === KEYBOARD_KEYS.ENTER && onClick()}
      >
        <Icon name="chevron-right" className="text-xs" />
        <Icon name={icon} className="text-sm" />
      </div>
    );
  }

  // Thin horizontal strip: chevron + icon + title
  return (
    <div
      className="flex flex-row items-center w-full h-[30px] px-2 gap-1 border-b border-panel-border bg-sidebar-bg cursor-pointer select-none text-description-fg hover:text-foreground transition-colors"
      onClick={onClick}
      role="button"
      aria-label={`Expand ${title}`}
      tabIndex={0}
      onKeyDown={(e) => e.key === KEYBOARD_KEYS.ENTER && onClick()}
    >
      <Icon name="chevron-right" className="text-xs" />
      <Icon name={icon} className="text-sm" />
      <span className="text-xs font-semibold uppercase tracking-wide">
        {title}
      </span>
    </div>
  );
};
