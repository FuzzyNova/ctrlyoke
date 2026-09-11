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

/**
 * Prefix for the sortable ids the steps panel gives pending steps. The id
 * encodes the step's absolute index in the workflow, so it is also the parser
 * for that index — keep both halves here so the panel and `ParallelGroupPanel`
 * cannot drift apart on the format.
 */
export const STEP_DRAG_ID_PREFIX = "step-pending-";

export function stepDragId(absoluteIndex: number): string {
  return `${STEP_DRAG_ID_PREFIX}${absoluteIndex}`;
}

export function isStepDragId(id: string): boolean {
  return id.startsWith(STEP_DRAG_ID_PREFIX);
}

export function absoluteIndexFromStepDragId(id: string): number {
  return Number.parseInt(id.slice(STEP_DRAG_ID_PREFIX.length), 10);
}

/**
 * Prefix for the sortable id of a parallel group's container. A group is a
 * first-class sibling in the steps panel's pending order: it can be dragged as
 * a unit, and a step dropped on it lands *beside* the group rather than inside
 * it (dropping on a member row is what joins a group).
 */
export const GROUP_DRAG_ID_PREFIX = "group-";

export function groupDragId(groupId: string): string {
  return `${GROUP_DRAG_ID_PREFIX}${groupId}`;
}

export function isGroupDragId(id: string): boolean {
  return id.startsWith(GROUP_DRAG_ID_PREFIX);
}

/**
 * Droppable id for the slot *after* the last pending container. It is rendered
 * only when that container is a parallel group, because a group is the one
 * container with no reachable slot below it: its own id means "the group's
 * position in the order", and a step leaving the group takes that position
 * from above. Without this id there is simply nothing a drop can resolve to
 * that means "after the trailing group", so a step dragged to the bottom of
 * the list could only ever land above it — or be absorbed into it.
 */
export const PENDING_TAIL_DRAG_ID = "pending-tail";
