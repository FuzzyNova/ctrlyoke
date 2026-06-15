import React from "react";
import { useNavHistory } from "@/navigation/useNavHistory";

interface NavHistoryControlsProps {
  /** Extra classes for outer spacing/layout in the host header. */
  className?: string;
}

const buttonClass = (enabled: boolean): string =>
  `inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 text-xs transition-colors focus:outline-none focus-visible:ring-1 ${
    enabled
      ? "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
      : "bg-btn-secondary-bg text-btn-secondary-fg opacity-40 cursor-not-allowed"
  }`;

/**
 * Back / forward navigation controls (VS Code style). Walks the shared
 * navigation history stack; disabled at the ends. Rendered both in the main
 * dashboard header and in the workspace-viewer header — both drive the same
 * history.
 */
export const NavHistoryControls: React.FC<NavHistoryControlsProps> = ({
  className = "",
}) => {
  const { canBack, canForward, back, forward } = useNavHistory();

  return (
    <div
      className={`fp-button-group ${className}`}
      role="group"
      aria-label="Navigation history"
    >
      <button
        type="button"
        onClick={back}
        disabled={!canBack}
        title="Back"
        aria-label="Go back"
        className={buttonClass(canBack)}
      >
        <i className="codicon codicon-arrow-left" />
      </button>
      <div className="fp-button-group-divider" />
      <button
        type="button"
        onClick={forward}
        disabled={!canForward}
        title="Forward"
        aria-label="Go forward"
        className={buttonClass(canForward)}
      >
        <i className="codicon codicon-arrow-right" />
      </button>
    </div>
  );
};
