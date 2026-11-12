import React from "react";

export interface LiveDotProps {
  /** Extra layout classes (alignment, margins, shrink). */
  className?: string;
  title?: string;
  "aria-label"?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "data-testid"?: string;
}

/**
 * The small pulsing green dot that marks something as live right now: a
 * streaming step, a running terminal, an executing run or workflow. Every
 * "live" marker uses this so they share one size, color and pulse rate.
 */
export const LiveDot: React.FC<LiveDotProps> = ({ className, ...rest }) => (
  <span
    {...rest}
    className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-indicator-success animate-pulse${
      className ? ` ${className}` : ""
    }`}
  />
);
