import React from "react";

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
}) => (
  <button
    type="button"
    className="text-bash-expand-link inline-flex h-[1.625em] shrink-0 items-center gap-1 rounded px-1 text-[length:var(--fp-output-font-size)] leading-none cursor-pointer bg-transparent border-0 font-inherit hover:underline"
    onClick={(event) => {
      event.preventDefault();
      onToggle();
    }}
    title={title}
    aria-label={ariaLabel ?? title ?? label}
    aria-expanded={expanded}
  >
    <i
      className={`codicon codicon-chevron-right text-[length:var(--fp-output-font-size-sm)] transition-transform duration-150 ${
        expanded ? "rotate-90" : ""
      }`}
    />
    {showLabel && label && (
      <span className="text-[length:var(--fp-output-font-size-sm)]">
        {label}
      </span>
    )}
  </button>
);

ToolCallExpandToggle.displayName = "ToolCallExpandToggle";
