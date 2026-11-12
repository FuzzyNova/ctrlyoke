import React from "react";

/**
 * Bordered, lightly tinted box that visually binds a cluster of related
 * property controls: a gating control plus the fields it reveals (worktree,
 * pre/end condition, sandbox → mode, tool permission mode → tool lists), or a
 * repeated entry such as one hook. Used by the workflow properties panel, the
 * prompt properties drawer and the shared list editors so every property
 * surface sections itself the same way.
 *
 * Children are stacked with `space-y-2` rather than flex `gap` so an
 * `AnimatedSection` that has unmounted leaves no trailing gap. Pass
 * `className` to override layout (e.g. `flex-1 flex flex-col min-h-0` for a
 * group that must fill its page).
 */
export const PropertyGroup: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <div
    className={`rounded-sm border border-property-group-border bg-property-group-bg p-2${
      className ? ` ${className}` : " space-y-2"
    }`}
  >
    {children}
  </div>
);
