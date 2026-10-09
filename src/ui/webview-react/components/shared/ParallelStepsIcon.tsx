import React from "react";
import { Split } from "lucide-react";
import { LucideIcon, type LucideIconSize } from "./LucideIcon";

export interface ParallelStepsIconProps {
  /** Defaults to `md`, the same 16px box as a codicon. */
  size?: LucideIconSize;
  /** Extra classes (colors, spacing, alignment overrides). */
  className?: string;
}

/**
 * The single icon for parallel steps (group headers, the chip rail, the
 * "Run in parallel" action). Lucide's `split` is flipped vertically so the
 * stem enters from the top and the branches point down at the steps the
 * icon sits above.
 */
export const ParallelStepsIcon: React.FC<ParallelStepsIconProps> = ({
  size,
  className,
}) => (
  <LucideIcon
    icon={Split}
    size={size}
    className={["-scale-y-100", className].filter(Boolean).join(" ")}
  />
);
