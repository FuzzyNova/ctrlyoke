import React from "react";

interface CollapsibleRegionProps {
  collapsed: boolean;
  /** Exactly one child; give it a non-visible overflow so it can shrink to 0. */
  children: React.ReactElement;
  id?: string;
  className?: string;
}

/**
 * CollapsibleRegion - animates its child's height open and closed.
 *
 * The motion lives in `.cy-collapsible` (globals.css) and matches
 * {@link AnimatedSection}'s. Use this one when the content should stay
 * mounted while collapsed or must not animate on first render; there it is
 * hidden from assistive technology and made inert so nothing inside can
 * take focus.
 */
export const CollapsibleRegion: React.FC<CollapsibleRegionProps> = ({
  collapsed,
  children,
  id,
  className = "",
}) => (
  <div
    id={id}
    data-collapsed={collapsed}
    aria-hidden={collapsed || undefined}
    inert={collapsed || undefined}
    className={`cy-collapsible ${className}`}
  >
    {children}
  </div>
);
