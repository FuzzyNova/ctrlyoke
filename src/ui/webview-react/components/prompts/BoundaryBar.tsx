import React from "react";

interface BoundaryBarProps {
  completedCount: number;
  skippedCount: number;
}

export const BoundaryBar: React.FC<BoundaryBarProps> = ({
  completedCount,
  skippedCount,
}) => {
  const label =
    skippedCount > 0
      ? `✓ ${completedCount} completed · ${skippedCount} skipped`
      : `✓ ${completedCount} completed`;

  return (
    <div className="flex items-center gap-2 px-3 py-1 select-none">
      <div className="flex-1 h-px bg-panel-border" />
      <span className="text-xxs uppercase tracking-widest text-description-fg whitespace-nowrap">
        {label}
      </span>
      <div className="flex-1 h-px bg-panel-border" />
    </div>
  );
};
