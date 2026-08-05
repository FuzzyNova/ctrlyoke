import React from "react";

interface ExpandCollapseAllDiffsButtonProps {
  anyDiffCollapsed: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  disabled?: boolean;
}

export const ExpandCollapseAllDiffsButton: React.FC<
  ExpandCollapseAllDiffsButtonProps
> = ({ anyDiffCollapsed, onExpand, onCollapse, disabled }) => (
  <button
    className="icon-btn py-1 px-1"
    title={anyDiffCollapsed ? "Expand all diffs" : "Collapse all diffs"}
    aria-label={anyDiffCollapsed ? "Expand all diffs" : "Collapse all diffs"}
    disabled={disabled}
    onClick={() => (anyDiffCollapsed ? onExpand() : onCollapse())}
  >
    <i
      className={`codicon codicon-lg ${anyDiffCollapsed ? "codicon-diff" : "codicon-diff-ignored"}`}
    />
  </button>
);
