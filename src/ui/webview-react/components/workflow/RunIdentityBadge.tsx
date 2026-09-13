import React from "react";

interface RunIdentityBadgeProps {
  /** "Run 1042" / "Draft", or narrow "#1042" / "Draft". */
  label: string;
  /** Full accessible name, e.g. "Run 1042 — browse runs of Workflow8". Always the full (non-narrow) form. */
  accessibleLabel: string;
  isActive: boolean;
  sizeClassName: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * RunIdentityBadge - the header split-button's third segment.
 *
 * Shows the viewed run's identity and opens the run panel for the displayed
 * lineage directly — the two-click path to "switch run of the current
 * workflow" (RUN_NAVIGATION_UX_PLAN.md). `WorkflowStatus` only mounts this
 * when the displayed lineage is drillable (more than one addressable
 * target); a single-run lineage keeps today's two-segment header exactly.
 */
export const RunIdentityBadge: React.FC<RunIdentityBadgeProps> = ({
  label,
  accessibleLabel,
  isActive,
  sizeClassName,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={accessibleLabel}
    title={accessibleLabel}
    aria-haspopup="listbox"
    aria-expanded={isActive}
    className={`workflow-button-run-badge cy-dropdown-row flex-shrink-0 truncate text-xs font-medium transition-colors bg-cmd-bg text-cmd-fg hover:bg-cmd-active-bg hover:text-cmd-active-fg ${sizeClassName} ${
      isActive
        ? "bg-cmd-active-bg text-cmd-active-fg cy-dropdown-row-selected"
        : ""
    }`}
  >
    {label}
  </button>
);
