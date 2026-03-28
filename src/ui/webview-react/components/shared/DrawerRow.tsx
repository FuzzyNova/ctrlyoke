import React from "react";

/**
 * Layout row used inside drawer page bodies.
 *
 * Wide: renders a 2-column grid (gap-4) side by side.
 * Narrow: renders children as a plain fragment so the parent's
 * space-y-* controls vertical spacing uniformly.
 */
export const DrawerRow: React.FC<{
  narrow: boolean;
  children: React.ReactNode;
}> = ({ narrow, children }) =>
  narrow ? (
    <>{children}</>
  ) : (
    <div className="grid grid-cols-2 gap-4">{children}</div>
  );
