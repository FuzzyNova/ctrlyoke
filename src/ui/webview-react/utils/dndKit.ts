import type { CSSProperties } from "react";

/**
 * Style for every dnd-kit drag handle in the dashboard. On touch devices,
 * dragging a handle inside a scrollable ancestor otherwise gets hijacked by
 * the browser's native pan/scroll gesture before the pointer sensor sees
 * enough movement to start the drag. Applied as an inline style (not the
 * `touch-none` Tailwind class) so it reliably wins over globals.css's
 * `button, [role="button"] { touch-action: manipulation }` base rule — every
 * handle is a button or carries dnd-kit's default `role="button"` attribute.
 */
export const DRAG_HANDLE_TOUCH_ACTION_STYLE: CSSProperties = {
  touchAction: "none",
};
