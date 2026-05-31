/**
 * Shared utilities for all portal dropdown components.
 */

const DROPDOWN_VIEWPORT_PADDING = 4;

/** The fixed popup coordinates computed by useDropdownPortalPosition. */
export interface PopupPosition {
  top?: number;
  bottom?: number;
  left: number;
  /** Standard width — matches the trigger button. Omit for min-width-based sizing. */
  width?: number;
  /** Minimum width — used by compact action menus wider than their trigger. */
  minWidth?: number;
  /** Maximum width — used to keep the popup inside the viewport. */
  maxWidth?: number;
  maxHeight: number;
}

/** Convert a CSS max-height prop string ("60vh", "150px") to pixels. */
export function parsePropMaxHeight(h: string): number {
  if (h.endsWith("vh")) return (parseFloat(h) / 100) * window.innerHeight;
  return parseFloat(h);
}

/**
 * Parse a pixel-sized CSS prop (e.g. "240px") to a numeric value.
 *
 * Returns undefined for unsupported units so callers can fall back safely.
 */
export function parsePixelProp(value?: string): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?px$/.test(trimmed) || /^\d+(\.\d+)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }
  return undefined;
}

export interface HorizontalPopupConstraint {
  left: number;
  width?: number;
  minWidth?: number;
  maxWidth: number;
}

/**
 * Clamp a popup's horizontal placement so it remains fully visible.
 */
export function constrainPopupToViewport({
  left,
  width,
  minWidth,
  maxWidth,
  preferredWidth,
  viewportWidth = window.innerWidth,
  padding = DROPDOWN_VIEWPORT_PADDING,
}: {
  left: number;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  preferredWidth?: number;
  viewportWidth?: number;
  padding?: number;
}): HorizontalPopupConstraint {
  const availableWidth = Math.max(0, viewportWidth - padding * 2);
  const effectiveMaxWidth = Math.min(
    maxWidth ?? Number.POSITIVE_INFINITY,
    availableWidth
  );
  const effectiveWidth =
    width !== undefined ? Math.min(width, effectiveMaxWidth) : undefined;
  const effectiveMinWidth =
    minWidth !== undefined ? Math.min(minWidth, effectiveMaxWidth) : undefined;
  const clampWidth = Math.min(
    Math.max(effectiveWidth ?? 0, preferredWidth ?? effectiveMinWidth ?? 0),
    effectiveMaxWidth
  );
  const clampedLeft = Math.max(
    padding,
    Math.min(left, viewportWidth - clampWidth - padding)
  );

  return {
    left: clampedLeft,
    width: effectiveWidth,
    minWidth: effectiveMinWidth,
    maxWidth: effectiveMaxWidth,
  };
}
