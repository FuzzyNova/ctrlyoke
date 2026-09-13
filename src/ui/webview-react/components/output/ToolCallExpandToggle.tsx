import React from "react";
import { Icon } from "../shared/Icon";

export interface ToolCallExpandToggleProps {
  expanded: boolean;
  onToggle: () => void;
  label?: string;
  showLabel?: boolean;
  title?: string;
  "aria-label"?: string;
}

/** Shared expand/collapse affordance for dense tool-call headers. */
export const ToolCallExpandToggle: React.FC<ToolCallExpandToggleProps> = ({
  expanded,
  onToggle,
  label,
  showLabel = false,
  title,
  "aria-label": ariaLabel,
}) => {
  const resolvedLabel = label?.replace(/^show\b/i, expanded ? "Hide" : "Show");

  return (
    <button
      type="button"
      className="self-start inline-flex h-[1.625em] shrink-0 items-center gap-1 whitespace-nowrap rounded bg-btn-secondary-bg px-1.5 text-[length:var(--cy-output-font-size-sm)] leading-none text-btn-secondary-fg transition-colors hover:bg-btn-secondary-hover cursor-pointer font-inherit"
      onClick={(event) => {
        event.preventDefault();
        onToggle();
      }}
      title={title}
      aria-label={ariaLabel ?? title ?? resolvedLabel}
      aria-expanded={expanded}
    >
      <Icon
        name={expanded ? "codicon-fold" : "codicon-unfold"}
        className="text-[length:var(--cy-output-font-size-sm)]"
      />
      {showLabel && resolvedLabel && (
        <span className="text-[length:var(--cy-output-font-size-xs)] uppercase">
          {resolvedLabel}
        </span>
      )}
    </button>
  );
};

ToolCallExpandToggle.displayName = "ToolCallExpandToggle";
