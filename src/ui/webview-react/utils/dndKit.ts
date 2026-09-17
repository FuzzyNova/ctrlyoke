import type { CSSProperties } from "react";
import type { DraggableAttributes } from "@dnd-kit/core";
import type { SortingStrategy } from "@dnd-kit/sortable";

type SyntheticListenerMap = Record<string, Function>;

/**
 * The pair of dnd-kit props (`useSortable`'s `listeners` + `attributes`) a
 * drag handle needs. Shared between `WorkflowStepRow` (which sources them
 * from `useSortable`) and `WorkflowStep` (which spreads them onto the actual
 * handle element) so the two stay in sync without an import cycle between
 * those files.
 */
export type WorkflowStepDragHandleProps = {
  listeners: SyntheticListenerMap | undefined;
  attributes: DraggableAttributes;
};

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

/**
 * The steps panel's sorting strategy: displace *siblings* not at all.
 *
 * A dnd-kit strategy exists to fake a reorder with transforms while the DOM
 * holds still. `WorkflowStepsPanel` does the reorder for real — it recomputes
 * a live preview and re-renders the list in its dragged order every time the
 * target changes — so a strategy transform applies the same move a second
 * time, and the two are not merely redundant: they point opposite ways. With
 * the preview already showing `[group] step`, the strategy hands that step
 * `-activeNodeRect.height`, and for a *group* drag that height is the whole
 * group, so the step is painted back above it. The list then reads `step
 * [group]` while the model says `[group] step`, and the drop — which is a pure
 * function of the model — lands the group a slot above where the screen
 * promised. `describePendingDragState`'s trace lines are how that is told
 * apart from a genuine model bug: preview, drop and committed all agree while
 * the screen disagreed.
 *
 * Only the strategy is neutralised. Two things deliberately stay:
 * - `useSortable`'s `transform` for the *dragged* item, which never goes
 *   through the strategy at all (with no dnd-kit `<DragOverlay>` mounted it
 *   comes from `shouldDisplaceDragSource` as the raw pointer translate). That
 *   is what keeps the dragged row and group panel under the cursor.
 * - the layout animation, which is `useDerivedTransform`'s FLIP, computed from
 *   `ignoreTransform: true` measurements of where the row actually moved. It
 *   is driven by the DOM reorder, not by this strategy, so rows still slide.
 *
 * Neutralising it cannot move a collision: droppables are measured with
 * `getTransformAgnosticClientRect`, which inverts each element's own computed
 * transform, and every transform here sits on the droppable node itself.
 */
export const livePreviewSortingStrategy: SortingStrategy = () => null;
