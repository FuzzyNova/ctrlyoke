/**
 * Shared utilities for all portal dropdown components.
 */

/** The fixed popup coordinates computed by useDropdownPortalPosition. */
export interface PopupPosition {
  top?: number;
  bottom?: number;
  left: number;
  /** Standard width — matches the trigger button. Omit for min-width-based sizing. */
  width?: number;
  /** Minimum width — used by compact action menus wider than their trigger. */
  minWidth?: number;
  maxHeight: number;
}

/** Convert a CSS max-height prop string ("60vh", "150px") to pixels. */
export function parsePropMaxHeight(h: string): number {
  if (h.endsWith("vh")) return (parseFloat(h) / 100) * window.innerHeight;
  return parseFloat(h);
}
