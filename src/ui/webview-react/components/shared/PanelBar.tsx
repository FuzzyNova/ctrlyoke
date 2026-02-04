import React from "react";

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
        className="flex flex-col justify-start items-center w-full h-full pt-1.5 gap-1 cursor-pointer select-none text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] transition-colors"
        onClick={onClick}
        role="button"
        aria-label={`Expand ${title}`}
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onClick()}
      >
        <i className="codicon codicon-chevron-right text-[12px]" />
        <i className={`codicon codicon-${icon} text-[14px]`} />
      </div>
    );
  }

  // Thin horizontal strip: chevron + icon + title
  return (
    <div
      className="flex flex-row items-center w-full px-2 py-1.5 gap-1 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)] cursor-pointer select-none text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] transition-colors"
      onClick={onClick}
      role="button"
      aria-label={`Expand ${title}`}
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
    >
      <i className="codicon codicon-chevron-right text-[12px]" />
      <i className={`codicon codicon-${icon} text-[14px]`} />
      <span className="text-[11px] font-semibold uppercase tracking-wide">
        {title}
      </span>
    </div>
  );
};
