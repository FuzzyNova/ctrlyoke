import React from "react";
import { Icon } from "../shared/Icon";

export interface ToolCallExpandToggleProps {
  expanded: boolean;
  /** Receives the clicked button, for callers that anchor scroll on it. */
  onToggle: (toggle: HTMLButtonElement) => void;
  label?: string;
  showLabel?: boolean;
  title?: string;
  "aria-label"?: string;
  "aria-controls"?: string;
}

/** Shared expand/collapse affordance for dense tool-call headers. */
export const ToolCallExpandToggle: React.FC<ToolCallExpandToggleProps> = ({
  expanded,
  onToggle,
  label,
  showLabel = false,
  title,
  "aria-label": ariaLabel,
  "aria-controls": ariaControls,
}) => {
  const resolvedLabel = label?.replace(/^show\b/i, expanded ? "Hide" : "Show");

  return (
    <button
      type="button"
      className="self-start inline-flex h-[1.625em] shrink-0 items-center gap-1 whitespace-nowrap rounded-sm bg-btn-secondary-bg px-1.5 text-(length:--cy-output-font-size-sm) leading-none text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover cursor-pointer font-inherit"
      onClick={(event) => {
        event.preventDefault();
        onToggle(event.currentTarget);
      }}
      title={title}
      aria-label={ariaLabel ?? title ?? resolvedLabel}
      aria-expanded={expanded}
      aria-controls={ariaControls}
    >
      <Icon
        name={expanded ? "codicon-fold" : "codicon-unfold"}
        className="text-(length:--cy-output-font-size-sm)"
      />
      {showLabel && resolvedLabel && (
        <span className="text-(length:--cy-output-font-size-xs) uppercase">
          {resolvedLabel}
        </span>
      )}
    </button>
  );
};

ToolCallExpandToggle.displayName = "ToolCallExpandToggle";
