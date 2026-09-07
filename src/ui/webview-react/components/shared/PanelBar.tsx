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
      <button
        type="button"
        className="flex h-full w-full appearance-none flex-col items-center justify-start gap-1 border-0 bg-transparent p-0 pt-1.5 text-description-fg transition-colors hover:text-foreground"
        onClick={onClick}
        aria-label={`Expand ${title}`}
      >
        <Icon name="chevron-right" className="text-xs" />
        <Icon name={icon} className="text-sm" />
      </button>
    );
  }

  // Thin horizontal strip: chevron + icon + title
  return (
    <button
      type="button"
      className="flex h-[30px] w-full appearance-none flex-row items-center gap-1 border-0 border-b border-panel-border bg-sidebar-bg px-2 text-left text-description-fg transition-colors hover:text-foreground"
      onClick={onClick}
      aria-label={`Expand ${title}`}
    >
      <Icon name="chevron-right" className="text-xs" />
      <Icon name={icon} className="text-sm" />
      <span className="text-xs font-semibold uppercase tracking-wide">
        {title}
      </span>
    </button>
  );
};
