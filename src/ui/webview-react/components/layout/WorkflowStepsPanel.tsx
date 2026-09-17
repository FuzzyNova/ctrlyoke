import React, { useCallback, useMemo, useRef, useState } from "react";
import { useWorkflowStore, type WorkflowStep } from "@store/workflowStore";
import {
  KEYBOARD_KEYS,
  MCP_SERVER_IDS,
  STEP_TYPES,
} from "@root/types/DashboardConstants";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import { useUiStore } from "@store/uiStore";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import {
  usePromptStatus,
  useStepClickHandler,
  useStepContextMenu,
  useFinalStepContextMenu,
  useLatestStepOutput,
  useFinalStepLatestOutput,
  usePasteToEndContextMenu,
  useLongPress,
  useSortableDndSensors,
  useIsViewingDeletedWorkflow,
  useIsSystemGeneratedWorkflow,
  useActiveWorkflowExternalOwner,
} from "@hooks/index";
import { HARNESS_INFO } from "../../types/messages";
import type { HarnessId } from "../../types/messages";
import { type PromptOverride } from "../prompts/WorkflowStep";
import { FinalStepFooter } from "../prompts/FinalStepFooter";
import { PromptCounter } from "../prompts/PromptCounter";
import { PromptChipRail } from "../prompts/PromptChipRail";
import { PauseBoundary } from "../prompts/ExecutingStepHighlight";
import {
  WorkflowStepRow,
  WorkflowStepRowFrame,
  SortableWorkflowStepWrapper,
} from "../prompts/WorkflowStepRow";
import {
  ParallelGroupPanel,
  isStepExecutionLocked,
} from "../prompts/ParallelGroupPanel";
import {
  MESSAGE_TYPES,
  STEP_STATUS,
  EXECUTION_STATES,
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
  type StepStatus,
} from "../../types/messages";
import { sendMessage } from "../../hooks/useMessageHandler";
import { getExternalReadOnlyLabel } from "@utils/externalRunner";
import {
  DndContext,
  closestCenter,
  useDroppable,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove } from "@dnd-kit/sortable";
import { triggerPanelAnimation } from "@utils/panelAnimation";
import { ExitButton } from "../shared";
import {
  isExecutionBusy,
  isStepExecuting,
  isWorkflowRunning,
} from "../../utils/status";
import {
  resolveStepColor,
  type StepColorGroupMember,
} from "../../utils/stepColor";
import {
  buildWorkflowStepEnabledState,
  isEditableClipboardTarget,
  readWorkflowStepFromClipboard,
  serializeWorkflowStepText,
  writeClipboardText,
} from "@utils/stepClipboard";
import { isParallelGroupTopologyLocked } from "@utils/stepContextMenuItems";
import {
  PENDING_TAIL_DRAG_ID,
  absoluteIndexFromStepDragId,
  groupDragId,
  isGroupDragId,
  isStepDragId,
  livePreviewSortingStrategy,
  stepDragId,
} from "@utils/dndKit";
import { Icon } from "../shared/Icon";

type PendingDragContainer = {
  id: string;
  items: string[];
  groupId?: string;
};

type PendingDragState = {
  order: string[];
  containers: Record<string, PendingDragContainer>;
};

const PENDING_DROP_TARGET_KINDS = {
  /** A position in the top-level pending order. */
  SIBLING: "sibling",
  /** A position inside one parallel group. */
  MEMBER: "member",
} as const;

/**
 * Where a drop lands, resolved from the id dnd-kit reports as `over`.
 *
 * The distinction the steps panel needs is "beside a group" versus "inside
 * one", and the id alone answers it: a *container* id (a standalone step, or a
 * parallel group) is a position in the top-level `order`, while a group
 * *member* id is a position inside that group. That is what makes a step
 * droppable above a leading group — the group's own id is a reachable
 * top-level slot (see `pendingDragCollisionDetection`), where before, every
 * collision over a group resolved to one of its members and the step could
 * only ever be absorbed into it.
 *
 * `PENDING_TAIL_DRAG_ID` is the one id that is not a container: it is the slot
 * past the end of `order`, which exists because a *trailing* group would
 * otherwise have no slot below it at all.
 *
 * A step drag can only ever reach a group's own id through
 * `pendingDragCollisionDetection`'s "above the first member" re-point (the
 * group's panel-spanning rect is kept out of `closestCenter` entirely), so
 * that id has exactly one meaning: **insert immediately before this group**.
 * It carries `beforeContainerId` to say so, because plain `orderIndex` is
 * `arrayMove` semantics — "take the slot this container currently holds",
 * which lands *after* the group for a downward drag and *before* it for an
 * upward one. Direction-dependence is wrong for a target the pointer chose
 * geometrically, and it was what sent a step dragged down onto a group's
 * header all the way past the group instead of parking it above.
 */
type PendingDropTarget =
  | {
      kind: typeof PENDING_DROP_TARGET_KINDS.SIBLING;
      orderIndex: number;
      /**
       * When set, the drop means "immediately before this container" rather
       * than "take `orderIndex`". Resolved against the order the dragged item
       * has already been removed from, so it reads the same in both drag
       * directions.
       */
      beforeContainerId?: string;
    }
  | {
      kind: typeof PENDING_DROP_TARGET_KINDS.MEMBER;
      containerId: string;
      itemIndex: number;
    };

export function resolvePendingDropTarget(
  state: PendingDragState,
  overId: string
): PendingDropTarget | undefined {
  if (overId === PENDING_TAIL_DRAG_ID) {
    return {
      kind: PENDING_DROP_TARGET_KINDS.SIBLING,
      orderIndex: state.order.length,
    };
  }
  if (state.containers[overId]) {
    const orderIndex = state.order.indexOf(overId);
    if (orderIndex < 0) return undefined;
    return state.containers[overId].groupId
      ? {
          kind: PENDING_DROP_TARGET_KINDS.SIBLING,
          orderIndex,
          beforeContainerId: overId,
        }
      : { kind: PENDING_DROP_TARGET_KINDS.SIBLING, orderIndex };
  }
  const ownerId = findPendingDragContainer(state, overId);
  if (!ownerId) return undefined;
  const owner = state.containers[ownerId];
  if (!owner.groupId) {
    const orderIndex = state.order.indexOf(ownerId);
    return orderIndex < 0
      ? undefined
      : { kind: PENDING_DROP_TARGET_KINDS.SIBLING, orderIndex };
  }
  return {
    kind: PENDING_DROP_TARGET_KINDS.MEMBER,
    containerId: ownerId,
    itemIndex: owner.items.indexOf(overId),
  };
}

/**
 * The parallel group, if any, that the done/pending boundary runs through:
 * its anchor has settled but at least one member has not.
 *
 * A group is one container and is drawn whole, so this state has to resolve to
 * one section or the other. It resolves to the done section, at the group's own
 * anchor — `ParallelGroupPanel` already dims per member (`index < currentStep`)
 * and offers each one the rewind/forward start-position direction that matches
 * its side of the boundary, so the whole group stays readable there while the
 * pending list below keeps starting at a step it genuinely owns.
 *
 * This is reachable without a run: `Set Start Position` onto a group's second
 * member rewinds to exactly here. It is deliberately *not* reachable while a
 * group is executing — `PromptQueue` holds `currentIndex` at the anchor until
 * the group closes, and `WorkflowExecutor.broadcastProgress` publishes that
 * index rather than a count of settled steps.
 */
export function straddlingParallelGroup(
  currentStep: number,
  parallelGroups: readonly ParallelGroupDefinition[]
): ParallelGroupDefinition | undefined {
  return parallelGroups.find(
    (group) => group.startIndex < currentStep && currentStep <= group.endIndex
  );
}

export function buildPendingDragState(
  steps: WorkflowStep[],
  currentStep: number,
  parallelGroups: ParallelGroupDefinition[]
): PendingDragState {
  const order: string[] = [];
  const containers: Record<string, PendingDragContainer> = {};
  const groupsByStart = new Map(
    parallelGroups
      .filter((group) => group.startIndex >= currentStep)
      .map((group) => [group.startIndex, group])
  );
  // Every grouped index, not just the ones in a pending container. A group
  // whose anchor already settled (`startIndex < currentStep <= endIndex`) is
  // drawn whole by the done section — see `straddlingParallelGroup` — so its
  // still-pending members must not also appear as loose pending rows here.
  const groupedIndices = new Set(
    parallelGroups.flatMap((group) =>
      Array.from(
        { length: group.endIndex - group.startIndex + 1 },
        (_, offset) => group.startIndex + offset
      )
    )
  );

  for (let index = currentStep; index < steps.length; index++) {
    const group = groupsByStart.get(index);
    if (group) {
      const id = groupDragId(group.id);
      const items = Array.from(
        { length: group.endIndex - group.startIndex + 1 },
        (_, offset) => stepDragId(group.startIndex + offset)
      );
      order.push(id);
      containers[id] = { id, items, groupId: group.id };
    } else if (!groupedIndices.has(index)) {
      const id = stepDragId(index);
      order.push(id);
      containers[id] = { id, items: [id] };
    }
  }
  return { order, containers };
}

function findPendingDragContainer(
  state: PendingDragState,
  id: string
): string | undefined {
  if (state.containers[id]) return id;
  return state.order.find((containerId) =>
    state.containers[containerId]?.items.includes(id)
  );
}

/**
 * Whether the pending list ends in a parallel group, and therefore needs the
 * tail slot rendered. Every other container ends in a step row whose own id is
 * already a reachable "drop below everything" target.
 */
export function hasTrailingPendingGroup(state: PendingDragState): boolean {
  const lastId = state.order[state.order.length - 1];
  return lastId ? Boolean(state.containers[lastId]?.groupId) : false;
}

function clonePendingDragState(state: PendingDragState): PendingDragState {
  return {
    order: [...state.order],
    containers: Object.fromEntries(
      Object.entries(state.containers).map(([id, container]) => [
        id,
        { ...container, items: [...container.items] },
      ])
    ),
  };
}

export function movePendingDragItem(
  state: PendingDragState,
  activeId: string,
  overId: string
): PendingDragState {
  const sourceId = findPendingDragContainer(state, activeId);
  // The target index is captured from the pre-mutation state (mirroring
  // dnd-kit's own arrayMove). Recomputing it after removing the dragged item
  // would under-count by one whenever the item being dragged sits before the
  // drop target in the same order/items array (i.e. dragging downward), since
  // the removal shifts everything after it left by one.
  const target = resolvePendingDropTarget(state, overId);
  if (!sourceId || !target) return state;
  const source = state.containers[sourceId];
  if (target.kind === PENDING_DROP_TARGET_KINDS.MEMBER) {
    // Reordering inside the step's own group is a within-container move.
    if (target.containerId === sourceId) return state;
  } else if (!source.groupId && state.order[target.orderIndex] === sourceId) {
    // A standalone step dropped on its own slot has not moved. A *member*
    // dropped on its group's slot has: it leaves the group and takes that slot.
    return state;
  }

  const next = clonePendingDragState(state);
  const nextSource = next.containers[sourceId];
  nextSource.items = nextSource.items.filter((id) => id !== activeId);

  if (nextSource.groupId && nextSource.items.length < 2) {
    const sourcePosition = next.order.indexOf(sourceId);
    next.order.splice(sourcePosition, 1);
    delete next.containers[sourceId];
    for (const item of nextSource.items) {
      const standalone = { id: item, items: [item] };
      next.order.splice(sourcePosition, 0, item);
      next.containers[item] = standalone;
    }
  } else if (!nextSource.groupId) {
    next.order = next.order.filter((id) => id !== sourceId);
    delete next.containers[sourceId];
  }

  if (target.kind === PENDING_DROP_TARGET_KINDS.MEMBER) {
    const destination = next.containers[target.containerId];
    if (!destination) return state;
    const insertIndex =
      target.itemIndex < 0
        ? destination.items.length
        : Math.min(target.itemIndex, destination.items.length);
    destination.items.splice(insertIndex, 0, activeId);
  } else {
    // `beforeContainerId` is resolved against the *post-removal* order so it
    // means the same thing whichever way the drag came from. It can be missing
    // when the dragged step was the second-to-last member of that very group
    // and taking it out dissolved the group; the remaining member has then
    // inherited the group's slot, so the pre-mutation `orderIndex` is still
    // exactly "before it".
    const beforeIndex = target.beforeContainerId
      ? next.order.indexOf(target.beforeContainerId)
      : -1;
    next.order.splice(
      beforeIndex >= 0
        ? beforeIndex
        : Math.min(target.orderIndex, next.order.length),
      0,
      activeId
    );
    next.containers[activeId] = { id: activeId, items: [activeId] };
  }
  return next;
}

/**
 * Move a whole parallel group to another top-level slot. Groups never nest, so
 * a drop that resolves inside another group is taken as that group's slot.
 */
export function movePendingDragContainer(
  state: PendingDragState,
  containerId: string,
  overId: string
): PendingDragState {
  if (!state.containers[containerId]) return state;
  const target = resolvePendingDropTarget(state, overId);
  if (!target) return state;
  const fromIndex = state.order.indexOf(containerId);
  const toIndex =
    target.kind === PENDING_DROP_TARGET_KINDS.SIBLING
      ? target.orderIndex
      : state.order.indexOf(target.containerId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return state;
  const next = clonePendingDragState(state);
  next.order = arrayMove(next.order, fromIndex, toIndex);
  return next;
}

/**
 * Reorder a member inside the parallel group it already belongs to. Top-level
 * siblings never reach this path — every one of them is its own container, so
 * their drops resolve as cross-container moves through `movePendingDragItem`.
 */
function movePendingDragMemberWithinGroup(
  state: PendingDragState,
  containerId: string,
  activeId: string,
  overId: string
): PendingDragState {
  const container = state.containers[containerId];
  if (!container?.groupId) return state;
  const fromIndex = container.items.indexOf(activeId);
  const toIndex = container.items.indexOf(overId);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return state;
  const next = clonePendingDragState(state);
  next.containers[containerId].items = arrayMove(
    container.items,
    fromIndex,
    toIndex
  );
  return next;
}

/**
 * Resolve the full live preview of the pending list for the current drag,
 * always computed fresh from the *committed* baseline — never from a
 * previously computed preview. This is what makes the preview trustworthy at
 * every frame and at drop: the result for a given (committed, activeId,
 * overId) triple is always the same, so there is nothing that can drift
 * across a drag with several crossings the way the old incremental
 * "fold whatever the last preview produced" approach could.
 *
 * A step whose own container differs from where it started (it moved across
 * a container boundary, or reordered within one) is applied with
 * `movePendingDragMemberWithinGroup` only when it is still hovering *within
 * its committed group*; every other case — a plain sibling move, a group
 * crossing in either direction, or a whole-group drag — goes through
 * `movePendingDragItem` / `movePendingDragContainer`, which already know how
 * to resolve a cross-container drop.
 */
export function computeLivePreviewState(
  committedState: PendingDragState,
  activeId: string,
  overId: string
): PendingDragState {
  if (!isStepDragId(activeId)) {
    return movePendingDragContainer(committedState, activeId, overId);
  }
  const sourceId = findPendingDragContainer(committedState, activeId);
  const target = resolvePendingDropTarget(committedState, overId);
  if (!sourceId || !target) return committedState;
  if (
    target.kind === PENDING_DROP_TARGET_KINDS.MEMBER &&
    target.containerId === sourceId
  ) {
    return movePendingDragMemberWithinGroup(
      committedState,
      sourceId,
      activeId,
      overId
    );
  }
  return movePendingDragItem(committedState, activeId, overId);
}

/**
 * Every rendered row's live display slot (0-based absolute step index),
 * keyed by drag id — the single source of truth for both the number shown
 * next to a row and, via `slotNumber - 1`, a unique-mode identity color. A
 * plain walk over the preview's containers in order: standalone steps and
 * parallel-group members are numbered by the same running counter, so two
 * rows can never land on the same number, and a step that crossed a group
 * boundary always shows the number matching where it is currently rendered
 * rather than where it started the drag.
 *
 * `baseIndex` is `currentStep` unless a parallel group straddles the
 * done/pending boundary, in which case its still-pending tail is rendered
 * elsewhere (see `straddlingParallelGroup`) and excluded from this list
 * entirely — the walk has to start after it. That case never overlaps with
 * an active drag: `canReorder` is already false whenever a straddling group
 * exists, so `state` is always the untouched committed baseline there.
 */
export function computeDisplaySlots(
  state: PendingDragState,
  baseIndex: number
): Map<string, number> {
  const slots = new Map<string, number>();
  let cursor = baseIndex;
  for (const containerId of state.order) {
    const container = state.containers[containerId];
    if (!container) continue;
    for (const itemId of container.items) {
      slots.set(itemId, cursor);
      cursor += 1;
    }
  }
  return slots;
}

export type PendingReorderPayload = {
  newPendingOrder: number[];
  pendingGroups: Array<{
    id?: string;
    start: number;
    end: number;
    failFast: boolean;
  }>;
};

export function buildPendingReorderPayload(
  state: PendingDragState,
  currentStep: number,
  parallelGroups: ParallelGroupDefinition[]
): PendingReorderPayload {
  const newPendingOrder: number[] = [];
  const pendingGroups: Array<{
    id?: string;
    start: number;
    end: number;
    failFast: boolean;
  }> = [];

  for (const containerId of state.order) {
    const container = state.containers[containerId];
    if (!container) continue;
    const start = newPendingOrder.length;
    for (const item of container.items) {
      newPendingOrder.push(absoluteIndexFromStepDragId(item) - currentStep);
    }
    if (container.groupId) {
      const group = parallelGroups.find(
        (candidate) => candidate.id === container.groupId
      );
      pendingGroups.push({
        id: container.groupId,
        start,
        end: newPendingOrder.length - 1,
        failFast: group?.failFast ?? true,
      });
    }
  }
  return { newPendingOrder, pendingGroups };
}

/**
 * Resolve the outcome of a drop, or `undefined` when it leaves the committed
 * topology unchanged. Goes through the exact same `computeLivePreviewState`
 * every live preview frame already used, against the same `committedState`
 * baseline — a drop can never apply something different from whatever was
 * last rendered, which is what a drag with several crossings used to be able
 * to get wrong.
 */
export function resolvePendingDragEnd(
  committedState: PendingDragState,
  activeId: string,
  overId: string,
  currentStep: number,
  parallelGroups: ParallelGroupDefinition[]
): { state: PendingDragState; payload: PendingReorderPayload } | undefined {
  const nextState = computeLivePreviewState(committedState, activeId, overId);
  const payload = buildPendingReorderPayload(
    nextState,
    currentStep,
    parallelGroups
  );
  const committedPayload = buildPendingReorderPayload(
    committedState,
    currentStep,
    parallelGroups
  );
  if (JSON.stringify(payload) === JSON.stringify(committedPayload)) {
    return undefined;
  }
  return { state: nextState, payload };
}

/**
 * `closestCenter`, with two corrections a nested sortable needs.
 *
 * A parallel group registers one droppable spanning the whole panel *and* one
 * per member row inside it, and the panel's rect is not the neutral outer box
 * it looks like: it covers the header as well as the members, so its centre
 * sits roughly half a header-height *above* the middle of the member band —
 * which for any group lands it right around the first member's lower half.
 * Left in `closestCenter`'s candidates it therefore beats the first member on
 * distance across most of that member's own row, and a group id means "beside
 * this group", so a step aimed at the group's first slot was pulled straight
 * back out of it. That is why every group container is filtered out here for a
 * step drag: a group's own slot is only ever reachable through the explicit
 * geometric rule below, never by winning on distance.
 *
 * That rule is the header: a collision on a member while the dragged centre is
 * still *above* the first member's top is re-pointed at the group, which means
 * "insert immediately before it" (see `resolvePendingDropTarget`). Everything
 * from the first member's top downwards belongs to the members themselves, one
 * clean band each.
 *
 * Past the last row of a *trailing* group the re-point goes to the tail slot,
 * the only id that says "after everything". It is kept out of `closestCenter`'s
 * own candidates and injected only by this rule, so it cannot poach the lower
 * half of the last member row — which is still a perfectly good place to join
 * the group. No other group needs a rule there: once the dragged centre clears
 * the last member's bottom it is inside the next container's own rect, whose
 * rows are nearer collisions than that last member is.
 *
 * Dragging a group has the mirror-image problem: its own members sit under the
 * pointer for the entire drag and would be the only collisions ever reported,
 * leaving `overIndex` outside the outer list and killing every transform. A
 * group can only land in a top-level slot anyway, so nothing else is offered.
 */
export function pendingDragCollisionDetection(
  state: PendingDragState
): CollisionDetection {
  return (args) => {
    const activeId = String(args.active.id);
    if (!isStepDragId(activeId)) {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) => {
          const id = String(container.id);
          return id !== activeId && state.order.includes(id);
        }),
      });
    }

    const collisions = closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((container) => {
        const id = String(container.id);
        return id !== PENDING_TAIL_DRAG_ID && !isGroupDragId(id);
      }),
    });
    const overId = collisions[0] ? String(collisions[0].id) : undefined;
    if (!overId) return collisions;
    const target = resolvePendingDropTarget(state, overId);
    if (target?.kind !== PENDING_DROP_TARGET_KINDS.MEMBER) return collisions;

    const items = state.containers[target.containerId]?.items ?? [];
    const firstMemberRect = args.droppableRects.get(items[0] ?? "");
    const lastMemberRect = args.droppableRects.get(
      items[items.length - 1] ?? ""
    );
    if (!firstMemberRect || !lastMemberRect) return collisions;

    const centerY = args.collisionRect.top + args.collisionRect.height / 2;
    if (centerY < firstMemberRect.top) {
      return [{ id: target.containerId }, ...collisions];
    }
    if (
      centerY >= lastMemberRect.bottom &&
      state.order[state.order.length - 1] === target.containerId
    ) {
      return [{ id: PENDING_TAIL_DRAG_ID }, ...collisions];
    }
    return collisions;
  };
}

/**
 * The drop slot below a trailing parallel group — a plain droppable, and
 * deliberately *not* one of the enclosing `SortableContext`'s items.
 *
 * It used to be listed there because `useSortable` throws away every transform
 * the moment `over` is not one of the context's own items, which once froze
 * the dragged row the instant the pointer cleared the group. This panel no
 * longer positions anything from those transforms (see
 * `livePreviewSortingStrategy`), so membership would buy nothing: a
 * `SortableContext`'s `items` feed `activeIndex`/`overIndex`, and those only
 * ever reach the strategy and the layout animation.
 */
const PendingTailDropSlot: React.FC = () => {
  const { setNodeRef } = useDroppable({ id: PENDING_TAIL_DRAG_ID });
  return (
    <div
      ref={setNodeRef}
      className="h-2"
      data-testid="pending-tail-drop-slot"
      aria-hidden="true"
    />
  );
};

function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
}
/**
 * WorkflowStepsPanel - Left panel showing the list of steps in the workflow
 *
 * Features:
 * - Collapsible header with step count
 * - List of PromptStep components with status
 * - Click to select step for editing
 * - Empty state when no steps loaded
 * - Retry and end condition result display
 */
const WorkflowStepsPanelInner: React.FC<{
  onRequestSidebar?: () => void;
  onRequestClose?: () => void;
}> = ({ onRequestSidebar, onRequestClose }) => {
  const {
    steps,
    parallelGroups,
    currentStep,
    activeStepIndices,
    executionState,
    retryStates,
    finalStep,
    finalStepStatus,
    finalStepLoopCount,
    finalStepPhase,
    liveContextWindow,
  } = useWorkflowStore();
  const {
    stepsCollapsed,
    togglePromptsCollapse,
    finalStepFooterExpanded,
    toggleFinalStepFooterExpanded,
    setFinalStepFooterExpanded,
    pendingRewind,
  } = useUiStore();

  const getPromptStatus = usePromptStatus();
  const stepClickHandler = useStepClickHandler();
  const getLatestOutput = useLatestStepOutput();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const activeExternalOwner = useActiveWorkflowExternalOwner();
  const isExternallyManaged = activeExternalOwner != null;
  const externalReadOnlyLabel = getExternalReadOnlyLabel(activeExternalOwner);
  // The lineage on screen was deleted while being viewed, or is an internal
  // system lineage (e.g. commit message generation) whose properties are
  // overridden by its owning feature on the next run regardless of what's
  // edited here — either way, nothing here has anywhere meaningful to write to.
  const isViewingDeletedWorkflow = useIsViewingDeletedWorkflow();
  const isSystemGeneratedWorkflow = useIsSystemGeneratedWorkflow();
  const isLineageReadOnly =
    isViewingDeletedWorkflow || isSystemGeneratedWorkflow;
  const { selectionTarget, selectPrompt, selectFinalStep, deselect } =
    useEditorStore();
  const { workflowProperties, globalSettings } = useSettingsStore();
  const [headerRef, isHeaderNarrow] = useElementNarrow<HTMLDivElement>(200);
  // Determine if workflow is running
  const isRunning = isWorkflowRunning(executionState);
  const isPaused = executionState === EXECUTION_STATES.PAUSED;
  const canChangeStartPosition =
    !isRunning && executionState !== EXECUTION_STATES.CANCELLING;
  const canPasteStep = executionState !== EXECUTION_STATES.CANCELLING;
  const pendingGroupRanges = useMemo(
    () =>
      parallelGroups
        .filter((group) => group.startIndex >= currentStep)
        .map((group) => ({
          id: group.id,
          start: group.startIndex - currentStep,
          end: group.endIndex - currentStep,
          failFast: group.failFast,
        })),
    [currentStep, parallelGroups]
  );
  const {
    openContextMenu,
    handleSetStartPosition,
    contextMenuPortal,
    setPositionModal,
    deleteModal,
  } = useStepContextMenu({
    isExternallyManaged,
    externalReadOnlyLabel,
    canChangeStartPosition,
    canPasteStep,
    executionState,
    confirmResetOperations: globalSettings.confirmResetOperations,
    confirmDeleteOperations: globalSettings.confirmDeleteOperations,
    totalSteps: steps.length,
    currentStep,
    pendingRewind: pendingRewind ?? undefined,
    parallelGroups,
    pendingGroups: pendingGroupRanges,
  });

  const { openPasteToEndMenu, pasteToEndMenuPortal } = usePasteToEndContextMenu(
    {
      isExternallyManaged,
      externalReadOnlyLabel,
      canPasteStep,
      executionState,
      totalSteps: steps.length,
    }
  );

  const bgLongPressHandlers = useLongPress(openPasteToEndMenu, 500, true);

  // Compute the harness/model to display for a step.
  //
  // For steps that have already started executing, use _runtime values so
  // the display shows what was actually used and doesn't change if the
  // workflow-level settings are later modified.
  //
  // For pending steps, compute from the three-tier precedence (step →
  // workflow → global) so the display stays live and reflects any changes.
  const getStepHarnessModel = useCallback(
    (step: (typeof steps)[0], status?: StepStatus) => {
      if (isScriptStep(step))
        return {
          harnessId: undefined,
          harnessLabel: undefined,
          harnessIsDefault: true,
          modelLabel: undefined,
          modelIsDefault: true,
        };
      // Use runtime values when they're present, OR when the step has reached a
      // terminal status and any _runtime exists — this covers the case where a step
      // completed after the last SESSION_RESTORED so harness/model weren't yet in
      // the working file snapshot but were since delivered via STEP_STATUS_CHANGED.
      const isTerminalStatus =
        status === STEP_STATUS.COMPLETED ||
        status === STEP_STATUS.FAILED ||
        status === STEP_STATUS.CANCELLED ||
        status === STEP_STATUS.SKIPPED;
      if (
        (step._runtime?.harness ?? step._runtime?.model) ||
        (isTerminalStatus && step._runtime != null)
      ) {
        const h = step._runtime?.harness;
        const m = step._runtime?.model;
        return {
          harnessId: h as HarnessId | undefined,
          harnessLabel: h
            ? (HARNESS_INFO[h as keyof typeof HARNESS_INFO]?.name ?? h)
            : undefined,
          harnessIsDefault: false,
          modelLabel: m,
          modelIsDefault: false,
        };
      }

      // Pending / queued — reflect live settings with default indicators
      const harnessIsDefault = step.harness === undefined;
      const modelIsDefault = step.model === undefined;
      const effectiveHarness =
        step.harness ?? workflowProperties.harness ?? globalSettings.harness;
      const effectiveModel =
        step.model ?? workflowProperties.model ?? globalSettings.model;
      return {
        harnessId: effectiveHarness as HarnessId | undefined,
        harnessLabel:
          HARNESS_INFO[effectiveHarness as keyof typeof HARNESS_INFO]?.name ??
          effectiveHarness,
        harnessIsDefault,
        modelLabel: effectiveModel,
        modelIsDefault,
      };
    },
    [globalSettings, workflowProperties]
  );

  // Compute the step-level property overrides to surface as chips.
  //
  // A property is shown when it is explicitly set at the step level AND
  // it meaningfully differs from (or adds to) the inherited workflow/global
  // default. Redundant chips — e.g. "ec: disabled" when the workflow is
  // already disabled — are suppressed so overrides reflect actual differences.
  const getStepOverrides = useCallback(
    (step: (typeof steps)[0]): PromptOverride[] => {
      const result: PromptOverride[] = [];

      if (step.executionMode !== undefined) {
        result.push({
          label:
            step.executionMode === EXECUTION_MODES.INTERACTIVE
              ? "Interactive"
              : "Headless",
          title: `executionMode: ${step.executionMode}`,
          icon:
            step.executionMode === EXECUTION_MODES.INTERACTIVE
              ? "debug-console"
              : "terminal",
        });
      }

      if (isScriptStep(step)) return result;

      // agent — show basename only, or explicit none when disabled
      if (step.agent === null) {
        result.push({
          label: "agent: none",
          title: "agent explicitly disabled",
        });
      } else if (step.agent != null) {
        const basename = step.agent.replace(/.*[\\/]/, "");
        result.push({
          label: `agent: ${basename}`,
          title: `agent: ${step.agent}`,
        });
      }

      // skills — show count, or explicit none when disabled
      if (step.skills === null) {
        result.push({
          label: "skills: none",
          title: "skills explicitly disabled",
        });
      } else if (step.skills != null && step.skills.length > 0) {
        result.push({
          label: `skills: ${step.skills.length}`,
          title: step.skills.join(", "),
        });
      }

      // mcpServers — show whenever explicitly set
      if (step.mcpServers !== undefined) {
        if (step.mcpServers === null) {
          result.push({
            label: "MCP: none",
            title: "MCP servers explicitly disabled",
          });
        } else if (Array.isArray(step.mcpServers)) {
          const count = step.mcpServers.length;
          const hasCtrlYoke = step.mcpServers.some(
            (s) => typeof s === "string" && s === MCP_SERVER_IDS.CTRLYOKE
          );
          const serverIds = step.mcpServers.map((s) =>
            typeof s === "string" ? s : ((s as { id?: string }).id ?? "custom")
          );
          if (count === 0) {
            result.push({
              label: "MCP: 0",
              title: "MCP servers explicitly set to empty",
            });
          } else if (hasCtrlYoke && count === 1) {
            result.push({ label: "MCP[ctrlyoke]", title: "MCP: ctrlyoke" });
          } else if (hasCtrlYoke) {
            result.push({
              label: `MCP[ctrlyoke]+${count - 1}`,
              title: serverIds.join(", "),
            });
          } else {
            result.push({
              label: `MCP: ${count}`,
              title: serverIds.join(", "),
            });
          }
        }
      }

      // hooks — show when explicitly set
      if (step.hooks !== undefined) {
        if (step.hooks === null) {
          result.push({ label: "hooks: none" });
        } else if (Array.isArray(step.hooks) && step.hooks.length > 0) {
          result.push({ label: `hooks: ${step.hooks.length}` });
        }
      }

      // resumeSession — show whenever explicitly set
      if (step.resumeSession !== undefined) {
        result.push({
          label: step.resumeSession ? "resume" : "no resume",
        });
      }

      // priorContext — show whenever explicitly set
      if (step.priorContext !== undefined) {
        let ctxLabel: string;
        if (Array.isArray(step.priorContext)) {
          ctxLabel = `ctx: [${step.priorContext.join(",")}]`;
        } else {
          // "all" | "previous" | "none" | "finalStepAll" | "finalStepPrevious"
          const shortMap: Record<string, string> = {
            all: "all",
            previous: "prev",
            none: "none",
            finalStepAll: "fs-all",
            finalStepPrevious: "fs-prev",
          };
          ctxLabel = `ctx: ${shortMap[step.priorContext as string] ?? String(step.priorContext)}`;
        }
        result.push({
          label: ctxLabel,
          title: `priorContext: ${String(step.priorContext)}`,
        });
      }

      // endCondition — only show "ec: disabled" if the workflow actually has an
      // active end condition to override. If the workflow is already disabled/unset,
      // the chip is redundant (the step value matches the inherited default).
      if (step.endCondition !== undefined) {
        if (step.endCondition === null) {
          const workflowHasActiveEndCondition =
            workflowProperties.endCondition != null &&
            Boolean(workflowProperties.endCondition.script);
          if (workflowHasActiveEndCondition) {
            result.push({ label: "ec: disabled" });
          }
        } else if (step.endCondition.script) {
          const script = step.endCondition.script;
          const basename = script.replace(/.*[\\/]/, "");
          const short =
            basename.length > 30 ? basename.substring(0, 30) + "…" : basename;
          result.push({
            label: `ec: ${short}`,
            title: `endCondition: ${script}`,
          });
        }
      }

      // preCondition — only show "pc: disabled" if the workflow has an active
      // pre-condition to override. If the workflow has none, the chip is redundant.
      if (step.preCondition !== undefined) {
        if (step.preCondition === null) {
          const workflowHasActivePreCondition =
            workflowProperties.preCondition != null &&
            Boolean(workflowProperties.preCondition.script);
          if (workflowHasActivePreCondition) {
            result.push({ label: "pc: disabled" });
          }
        } else if (step.preCondition.script) {
          const script = step.preCondition.script;
          const basename = script.replace(/.*[\\/]/, "");
          const short =
            basename.length > 30 ? basename.substring(0, 30) + "…" : basename;
          result.push({
            label: `pc: ${short}`,
            title: `preCondition: ${script}`,
          });
        }
      }

      // additionalArgs — show when explicitly set or disabled
      if (step.additionalArgs !== undefined) {
        if (step.additionalArgs === null) {
          result.push({
            label: "args: none",
            title: "additionalArgs explicitly disabled",
          });
        } else {
          const short =
            step.additionalArgs.length > 20
              ? step.additionalArgs.substring(0, 20) + "…"
              : step.additionalArgs;
          result.push({
            label: `args: ${short}`,
            title: `additionalArgs: ${step.additionalArgs}`,
          });
        }
      }

      // toolPermissions — show when explicitly set or disabled
      if (step.toolPermissions !== undefined) {
        if (step.toolPermissions === null) {
          result.push({
            label: "perms: none",
            title: "toolPermissions explicitly disabled",
          });
        } else if (step.toolPermissions.mode) {
          const modeShort: Record<string, string> = {
            dangerouslyAllowAll: "allow all!",
            allowAll: "allow all",
            custom: "custom",
            passthrough: "pass-thru",
          };
          const short =
            modeShort[step.toolPermissions.mode] ?? step.toolPermissions.mode;
          result.push({
            label: `perms: ${short}`,
            title: `toolPermissions: ${step.toolPermissions.mode}`,
          });
        }
      }

      return result;
    },
    [workflowProperties]
  );

  // Handle clicking a step to edit it (disabled in CLI watch mode)
  const handleStepClick = useCallback(
    (index: number) => {
      if (isExternallyManaged) return;
      stepClickHandler(index);
    },
    [isExternallyManaged, stepClickHandler]
  );

  const handleFinalStepSelect = useCallback(() => {
    if (isExternallyManaged || isLineageReadOnly) return;
    if (finalStep) {
      selectFinalStep(finalStep);
    } else {
      setFinalStepFooterExpanded(true);
      selectPrompt({ kind: FINAL_STEP_PHASES.FINAL_STEP }, { prompt: "" });
    }
  }, [
    isExternallyManaged,
    isLineageReadOnly,
    finalStep,
    selectFinalStep,
    setFinalStepFooterExpanded,
    selectPrompt,
  ]);

  const sensors = useSortableDndSensors();
  const executionOwnsCurrentStep = isExecutionBusy(executionState);
  const reorderableStepCount = executionOwnsCurrentStep
    ? steps.length - currentStep - 1
    : steps.length - currentStep;
  // A reorder payload is slice-relative to `currentStep` and has to cover every
  // step from there on (`PromptQueue.reorderPendingPrompts`). While a group
  // straddles the boundary its unfinished members live in a container the
  // pending list does not own, so no drag here can describe a valid payload —
  // and that group's topology is locked in this state anyway.
  const straddlingGroup = useMemo(
    () => straddlingParallelGroup(currentStep, parallelGroups),
    [currentStep, parallelGroups]
  );
  const canReorder =
    executionState !== EXECUTION_STATES.CANCELLING &&
    reorderableStepCount > 1 &&
    !straddlingGroup;

  const committedDragState = useMemo(
    () => buildPendingDragState(steps, currentStep, parallelGroups),
    [currentStep, parallelGroups, steps]
  );

  /**
   * A locally-applied drop result, shown immediately in place of the (now
   * stale) committed order until the round trip to the extension host
   * confirms it — otherwise every drop would flash back to its pre-drop order
   * for one render while the message is in flight. Cleared whenever fresh
   * committed data arrives, whether that's this same drop landing or
   * something else superseding it.
   *
   * Cleared during render (React's supported "adjusting state when a prop
   * changes" pattern), not from a `useEffect`. A drag id embeds the absolute
   * index it had when `buildPendingDragState` ran (see `stepDragId`), so it is
   * only meaningful paired with the exact `steps` array it was derived from.
   * The store's `steps` updates the instant the round trip lands — in the
   * very same render as `committedDragState` recomputing from it — but an
   * effect-based clear runs a whole render *later*, after that update has
   * already committed. For that one render, every row lookup elsewhere in
   * this component reads the *new* `steps` while still walking the *stale*
   * optimistic order's ids, so a row can end up rendering a completely
   * different step than the one whose slot it occupies — the reported
   * "flash of the old step" before things settle. Clearing synchronously
   * here means the switch from stale-ids-over-new-steps to
   * fresh-ids-over-new-steps happens before that render is ever painted.
   */
  const [optimisticDragState, setOptimisticDragState] =
    useState<PendingDragState | null>(null);
  const [prevCommittedDragState, setPrevCommittedDragState] =
    useState(committedDragState);
  if (committedDragState !== prevCommittedDragState) {
    setPrevCommittedDragState(committedDragState);
    if (optimisticDragState !== null) {
      setOptimisticDragState(null);
    }
  }

  const baselineDragState = optimisticDragState ?? committedDragState;

  /** The step or group currently being dragged, or `null` when idle. */
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  /** What the pointer is currently over, or `null` before the first measurement. */
  const [overDragId, setOverDragId] = useState<string | null>(null);

  /**
   * The dragged row's measured position at drag start, in viewport
   * coordinates — set once per drag (cheap, low frequency) so the overlay
   * clone below can render at a fixed `top`/`left` and let its `transform`
   * (mutated directly on the node, not through state — see
   * `handleDragOverlayMove`) carry all the per-frame movement.
   *
   * This clone exists instead of dnd-kit's own `<DragOverlay>` because that
   * component is unusable here: its internal `AnimationManager` calls
   * `React.cloneElement` unconditionally the instant a drag ends (to keep the
   * previous overlay content mounted for the drop animation), and under the
   * installed React version that throws `TypeError: reactDispatcher.getOwner
   * is not a function` — crashing the whole dashboard on *every* drop,
   * confirmed via manual testing, regardless of `dropAnimation` config (the
   * clone happens whether or not an animation is configured). There is no
   * newer `@dnd-kit/core` release that fixes this. Do not swap this back for
   * `<DragOverlay>` without confirming that incompatibility is gone.
   */
  const [dragOverlayRect, setDragOverlayRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const dragOverlayNodeRef = useRef<HTMLDivElement | null>(null);

  /**
   * The full live preview of the pending list for the current drag — always
   * recomputed fresh from `baselineDragState`, never incrementally built on a
   * previous preview (see `computeLivePreviewState`). This is what every
   * rendered row's number, color, and container membership is driven from
   * while idle and while dragging alike.
   */
  const previewDragState = useMemo(
    () =>
      activeDragId && overDragId
        ? computeLivePreviewState(baselineDragState, activeDragId, overDragId)
        : baselineDragState,
    [baselineDragState, activeDragId, overDragId]
  );

  /** Absolute 0-based display slot per drag id, from the live preview. */
  const displaySlots = useMemo(
    () =>
      computeDisplaySlots(
        previewDragState,
        straddlingGroup ? straddlingGroup.endIndex + 1 : currentStep
      ),
    [previewDragState, straddlingGroup, currentStep]
  );

  const resolveSlotNumber = useCallback(
    (id: string) => (displaySlots.get(id) ?? 0) + 1,
    [displaySlots]
  );

  const handleFailFastChange = useCallback(
    (group: (typeof parallelGroups)[number], failFast: boolean) => {
      if (
        isParallelGroupTopologyLocked(group, steps, currentStep, executionState)
      ) {
        return;
      }
      sendMessage(MESSAGE_TYPES.REORDER_PROMPTS, {
        newPendingOrder: Array.from(
          { length: steps.length - currentStep },
          (_, index) => index
        ),
        pendingGroups: pendingGroupRanges.map((candidate) =>
          candidate.id === group.id ? { ...candidate, failFast } : candidate
        ),
      });
    },
    [currentStep, executionState, pendingGroupRanges, steps]
  );

  const renderParallelGroup = useCallback(
    (group: (typeof parallelGroups)[number], isPending = false) => (
      <ParallelGroupPanel
        key={`parallel-${group.id}`}
        group={group}
        steps={steps}
        currentStep={currentStep}
        activeStepIndices={activeStepIndices}
        executionState={executionState}
        statuses={steps
          .slice(group.startIndex, group.endIndex + 1)
          .map((step, offset) =>
            getPromptStatus(step, group.startIndex + offset)
          )}
        retryStates={retryStates}
        liveContextWindow={liveContextWindow ?? {}}
        selectedIndex={
          selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
            ? selectionTarget.index
            : undefined
        }
        canSetStartPosition={canChangeStartPosition}
        getLatestOutput={getLatestOutput}
        getStepHarnessModel={getStepHarnessModel}
        stepColorMode={globalSettings.stepColorMode}
        harnessColorSettings={globalSettings.harnessColors}
        getStepOverrides={getStepOverrides}
        onStepClick={handleStepClick}
        onSetStartPosition={handleSetStartPosition}
        onOpenContextMenu={openContextMenu}
        onFailFastChange={handleFailFastChange}
        containerId={groupDragId(group.id)}
        memberIds={
          isPending
            ? previewDragState.containers[groupDragId(group.id)]?.items
            : undefined
        }
        resolveSlotNumber={isPending ? resolveSlotNumber : undefined}
        dragDisabled={
          !canReorder ||
          isParallelGroupTopologyLocked(
            group,
            steps,
            currentStep,
            executionState
          )
        }
      />
    ),
    [
      canChangeStartPosition,
      currentStep,
      activeStepIndices,
      executionState,
      getLatestOutput,
      getPromptStatus,
      getStepHarnessModel,
      getStepOverrides,
      globalSettings.harnessColors,
      globalSettings.stepColorMode,
      handleFailFastChange,
      handleSetStartPosition,
      handleStepClick,
      canReorder,
      previewDragState,
      resolveSlotNumber,
      liveContextWindow,
      openContextMenu,
      retryStates,
      selectionTarget,
      steps,
    ]
  );

  const handleToggleFinalStepEnabled = useCallback(() => {
    if (isExternallyManaged || isLineageReadOnly || !finalStep) return;
    const enabling = finalStep.enabled === false;
    sendMessage(MESSAGE_TYPES.UPDATE_FINAL_PROMPT, {
      finalStep: buildWorkflowStepEnabledState(finalStep, enabling),
      ...(enabling ? { clearProperties: ["enabled"] } : {}),
    });
  }, [isExternallyManaged, isLineageReadOnly, finalStep]);

  const handleSelectedStepCopy = useCallback(() => {
    if (selectionTarget.kind !== FINAL_STEP_PHASES.QUEUE) {
      return;
    }

    const selectedStep = steps[selectionTarget.index];
    if (!selectedStep) {
      return;
    }

    void writeClipboardText(serializeWorkflowStepText(selectedStep));
  }, [selectionTarget, steps]);

  const handleSelectedStepPaste = useCallback(() => {
    if (
      isExternallyManaged ||
      isLineageReadOnly ||
      !canPasteStep ||
      selectionTarget.kind !== FINAL_STEP_PHASES.QUEUE
    ) {
      return;
    }

    const afterIndex = selectionTarget.index;
    void readWorkflowStepFromClipboard()
      .then((step) => {
        sendMessage(MESSAGE_TYPES.INSERT_WORKFLOW_STEP, {
          afterIndex,
          step,
        });
      })
      .catch(() => {});
  }, [canPasteStep, isExternallyManaged, isLineageReadOnly, selectionTarget]);

  const finalStepIsReadOnly =
    isExternallyManaged ||
    isLineageReadOnly ||
    (finalStepPhase === FINAL_STEP_PHASES.FINAL_STEP &&
      finalStepStatus === STEP_STATUS.RUNNING);
  // A running final step remains selectable so its prompt can be reviewed and
  // edited locally. The editor footer prevents updating or deleting it until
  // execution finishes; only CLI-managed / read-only lineages block editor
  // selection outright.
  const finalStepSelectionIsReadOnly = isExternallyManaged || isLineageReadOnly;

  // Get the latest CLI output for the current final step loop
  const finalStepLatestOutput = useFinalStepLatestOutput();
  const finalStepOutputText = finalStepLatestOutput?.response as
    string | undefined;

  const { openFinalStepContextMenu, finalStepContextMenuPortal } =
    useFinalStepContextMenu({
      finalStep,
      isReadOnly: finalStepIsReadOnly,
      isDisabled: finalStep?.enabled === false,
      onToggleEnabled: handleToggleFinalStepEnabled,
      outputText: finalStepOutputText,
      latestOutput: finalStepLatestOutput,
      runtimeMeta:
        finalStep && !isScriptStep(finalStep) ? finalStep._runtime : undefined,
    });

  // Compute resolved harness/model for the final step using the same
  // three-tier logic as regular steps, so defaults are shown correctly.
  const getFinalStepHarnessModel = () => {
    if (!finalStep || isScriptStep(finalStep)) return {};
    if (finalStep._runtime?.harness ?? finalStep._runtime?.model) {
      const h = finalStep._runtime!.harness;
      const m = finalStep._runtime!.model;
      return {
        harnessId: h as HarnessId | undefined,
        harnessLabel: h
          ? (HARNESS_INFO[h as keyof typeof HARNESS_INFO]?.name ?? h)
          : undefined,
        harnessIsDefault: false,
        modelLabel: m,
        modelIsDefault: false,
      };
    }
    const harnessIsDefault = finalStep.harness === undefined;
    const modelIsDefault = finalStep.model === undefined;
    const effectiveHarness =
      finalStep.harness ?? workflowProperties.harness ?? globalSettings.harness;
    const effectiveModel =
      finalStep.model ?? workflowProperties.model ?? globalSettings.model;
    return {
      harnessId: effectiveHarness as HarnessId | undefined,
      harnessLabel:
        HARNESS_INFO[effectiveHarness as keyof typeof HARNESS_INFO]?.name ??
        effectiveHarness,
      harnessIsDefault,
      modelLabel: effectiveModel,
      modelIsDefault,
    };
  };

  const finalStepColor = finalStep
    ? resolveStepColor({
        step: finalStep,
        harnessId: getFinalStepHarnessModel().harnessId,
        stepIndex: steps.length,
        stepColorMode: globalSettings.stepColorMode,
        settings: globalSettings.harnessColors,
      })
    : undefined;

  // Compute overrides for the final step (same logic as regular steps)
  const finalStepOverrides = finalStep
    ? getStepOverrides(finalStep)
    : undefined;

  /** Latest drag position dnd-kit measured, or `null` before the first one. */
  const dragPositionRef = useRef<number | null>(null);

  const collisionDetection = useMemo<CollisionDetection>(() => {
    const detect = pendingDragCollisionDetection(previewDragState);
    return (args) => {
      // `collisionRect` is the drag's *input* position: dnd-kit subtracts the
      // active node's re-measurement delta from the sensor translate, so it
      // resolves to `initialActiveNodeRect + translate` and moves only when a
      // sensor moves. That is the property `handleDragOver` needs and cannot
      // get from its own event — `event.delta` is the modified translate,
      // which shifts by a row height the instant the preview relocates a
      // row's DOM node. Recorded during render because collision detection
      // runs in the render that produces the `over` this drag reacts to;
      // nothing renders off it.
      dragPositionRef.current = args.collisionRect.top;
      return detect(args);
    };
  }, [previewDragState]);

  // A trailing parallel group is the only container with no slot below it, so
  // the tail is rendered (and listed) only for that case — everywhere else the
  // last step row's own id already means "drop below everything".
  const showPendingTail =
    canReorder && hasTrailingPendingGroup(previewDragState);

  /**
   * Drag position at which `overDragId` was last updated. Every live-preview
   * recompute reflows the list (a row's DOM node can move between nested
   * `SortableContext`s), which makes dnd-kit re-measure every droppable
   * against a drag position that did not move; the new rects can resolve
   * `over` right back to a different id purely from that reflow, and
   * `onDragOver` fires on every `over` change. Nothing in that cycle needs the
   * user to move, so unless it's capped here it spins until React tears the
   * webview down with "Maximum update depth exceeded" (minified #185). At
   * most one `overDragId` update per measured position is enough: recomputing
   * the preview is pure and always starts from the same `baselineDragState`,
   * so refusing a redundant update never loses anything — `handleDragEnd`
   * resolves the drop from that same baseline regardless of how many
   * intermediate positions were skipped.
   */
  const lastAppliedPositionRef = useRef<number | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    lastAppliedPositionRef.current = null;
    setActiveDragId(String(event.active.id));
    // `over` isn't known yet at drag start — the first `onDragOver` fires
    // almost immediately and fills it in; until then the preview falls back
    // to `baselineDragState` (see `previewDragState`).
    setOverDragId(null);
    const initial = event.active.rect.current.initial;
    setDragOverlayRect(
      initial
        ? { top: initial.top, left: initial.left, width: initial.width }
        : null
    );
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over ? String(event.over.id) : null;
    // The dragged row is rendered by the live preview at the slot the preview
    // put it in, so once it has moved at all, the pointer is sitting on top of
    // the row's *own* droppable and `over` resolves to the active id. That is
    // not a drop target: it says the preview already matches the pointer, so
    // the only correct response is to leave it alone. Feeding it through would
    // make `computeLivePreviewState` resolve a self-drop and fall back to the
    // untouched committed baseline — the row snapping out of wherever it was
    // previewed and back to where the drag began. It is worst on an upward
    // drag into a parallel group, where the previewed row lands squarely under
    // the pointer, so every other frame cancelled the one before it and the
    // first member slot could never be held long enough to drop onto.
    // The drag position is deliberately *not* recorded for this case: nothing
    // was applied, so a real target arriving at the same position still may.
    if (overId !== null && overId === String(event.active.id)) return;
    const position = dragPositionRef.current;
    if (position !== null && position === lastAppliedPositionRef.current) {
      return;
    }
    lastAppliedPositionRef.current = position;
    setOverDragId(overId);
  }, []);

  /**
   * Moves the hand-rolled overlay clone by mutating its transform directly on
   * the DOM node rather than through React state — this fires on every
   * pointer move, and routing it through `setState` would re-render the
   * whole panel every frame, reintroducing the jank the live-preview redesign
   * was meant to remove. See `dragOverlayNodeRef` for why this element exists
   * at all instead of dnd-kit's own `<DragOverlay>`.
   */
  const handleDragOverlayMove = useCallback((event: DragMoveEvent) => {
    const node = dragOverlayNodeRef.current;
    if (!node) return;
    node.style.transform = `translate3d(${event.delta.x}px, ${event.delta.y}px, 0)`;
  }, []);

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    lastAppliedPositionRef.current = null;
    setActiveDragId(null);
    setOverDragId(null);
    setDragOverlayRect(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      // `overDragId` (not `event.over`) is the source of truth for the drop
      // target. Recomputing the live preview on every `onDragOver` reflows the
      // list, which makes dnd-kit re-measure every droppable — and at the
      // exact position where the drag is about to settle, that re-measurement
      // finds the *dragged row's own* rect has moved (via the reflow) to
      // where the target used to be, so a second collision pass at the same
      // position resolves `over` back to the active id itself. That second,
      // self-referencing pass is always what dnd-kit hands `onDragEnd` —
      // `overDragId` never picks it up because it is exactly the same
      // repeated-position bounce `lastAppliedPositionRef` already exists to
      // reject for the live preview (see its comment). Trusting `event.over`
      // here made a drop silently no-op whenever the settle-then-release
      // happened fast enough for that bounce to be the last thing dnd-kit
      // measured — reproducible on every drop, not just at the ends of the
      // list, but most visible there because there is nowhere left to
      // overshoot into that would otherwise re-arm a correct resolution.
      const overId =
        overDragId ?? (event.over ? String(event.over.id) : undefined);
      lastAppliedPositionRef.current = null;
      setActiveDragId(null);
      setOverDragId(null);
      setDragOverlayRect(null);
      const activeId = String(event.active.id);
      if (!overId) return;

      const outcome = resolvePendingDragEnd(
        baselineDragState,
        activeId,
        overId,
        currentStep,
        parallelGroups
      );
      if (!outcome) return;
      setOptimisticDragState(outcome.state);
      sendMessage(MESSAGE_TYPES.REORDER_PROMPTS, outcome.payload);

      const editorStore = useEditorStore.getState();
      if (editorStore.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE) {
        editorStore.cancelEdit();
      }
    },
    [baselineDragState, currentStep, overDragId, parallelGroups]
  );

  /**
   * The floating clone that follows the cursor while dragging — a full clone
   * of the real row (or, for a whole-group drag, the group's header bar),
   * reusing the same components and live slot/color resolution as the real
   * list. This is what decouples the dragged row's cursor-follow motion from
   * the real list's re-layout: the real row underneath only ever needs its
   * ordinary `isDragging` fade (already handled by
   * `SortableWorkflowStepWrapper` / `ParallelGroupPanel`), never to be kept
   * under the pointer itself.
   */
  function renderDragOverlayContent(): React.ReactNode {
    if (!activeDragId) return null;
    if (!isStepDragId(activeDragId)) {
      const group = parallelGroups.find(
        (candidate) => groupDragId(candidate.id) === activeDragId
      );
      if (!group) return null;
      return (
        <div className="flex items-center gap-2 rounded border border-panel-border bg-sidebar-bg px-2 py-1.5 text-xs shadow-lg">
          <Icon name="worktree-compact" className="text-description-fg" />
          <span className="font-semibold">
            Parallel steps {group.startIndex + 1}–{group.endIndex + 1}
          </span>
        </div>
      );
    }

    const index = absoluteIndexFromStepDragId(activeDragId);
    const step = steps[index];
    if (!step) return null;
    const slotNumber = resolveSlotNumber(activeDragId);
    const status = getPromptStatus(step, index);
    const harnessModel = getStepHarnessModel(step, status);

    const containerId = findPendingDragContainer(
      previewDragState,
      activeDragId
    );
    const container = containerId
      ? previewDragState.containers[containerId]
      : undefined;
    const group = container?.groupId
      ? parallelGroups.find((candidate) => candidate.id === container.groupId)
      : undefined;
    let offsetInGroup: number | undefined;
    let colorGroupMembers: StepColorGroupMember[] | undefined;
    if (group && container) {
      offsetInGroup = container.items.indexOf(activeDragId);
      colorGroupMembers = container.items.map((itemId, offset) => {
        const memberIndex = absoluteIndexFromStepDragId(itemId);
        const memberStep = steps[memberIndex];
        return {
          step: memberStep,
          harnessId: getStepHarnessModel(
            memberStep,
            getPromptStatus(memberStep, memberIndex)
          ).harnessId,
          offsetInGroup: offset,
        };
      });
    }
    const stepColor = resolveStepColor({
      step,
      harnessId: harnessModel.harnessId,
      stepIndex: slotNumber - 1,
      group,
      offsetInGroup,
      stepColorMode: globalSettings.stepColorMode,
      settings: globalSettings.harnessColors,
      groupMembers: colorGroupMembers,
    });

    return (
      <div className="overflow-hidden rounded border border-panel-border bg-editor-bg shadow-lg">
        <WorkflowStepRowFrame
          index={index}
          slotNumber={slotNumber}
          status={status}
          stepColor={stepColor}
          isCurrent={false}
        >
          <WorkflowStepRow
            step={step}
            index={index}
            slotNumber={slotNumber}
            currentStep={currentStep}
            executionState={executionState}
            status={status}
            retryState={retryStates[index]}
            latestOutput={getLatestOutput(index)}
            liveContextWindow={liveContextWindow?.[index]}
            isCurrent={false}
            isSelected={false}
            canSetStartPosition={false}
            startPositionDirection="forward"
            setPositionTarget={index}
            isExecutionTargetLocked={false}
            getStepHarnessModel={getStepHarnessModel}
            getStepOverrides={getStepOverrides}
            onStepClick={() => {}}
            onSetStartPosition={() => {}}
            onOpenContextMenu={() => {}}
          />
        </WorkflowStepRowFrame>
      </div>
    );
  }

  // In mobile mode (onRequestClose present), disable all collapse interactions —
  // the panel is a full-screen overlay and has its own close button.
  const isMobileMode = Boolean(onRequestClose);

  function handleToggle() {
    if (isMobileMode) return;
    triggerPanelAnimation();
    togglePromptsCollapse();
  }

  if (stepsCollapsed && !isMobileMode) {
    return (
      <PromptChipRail
        onExpand={handleToggle}
        getStepHarnessModel={getStepHarnessModel}
      />
    );
  }

  return (
    <div className="flex flex-col h-full bg-editor-bg cy-no-select">
      {/* Header — clickable to collapse in desktop mode; non-interactive in mobile */}
      <div
        ref={headerRef}
        className={`flex items-center h-[30px] px-2 border-b border-panel-border bg-sidebar-bg flex-shrink-0 transition-colors${isMobileMode ? "" : " cursor-pointer select-none text-description-fg hover:text-foreground"}`}
        onClick={isMobileMode ? undefined : handleToggle}
        role={isMobileMode ? undefined : "button"}
        aria-label={isMobileMode ? undefined : "Collapse steps"}
        tabIndex={isMobileMode ? undefined : 0}
        onKeyDown={
          isMobileMode
            ? undefined
            : (e) => e.key === KEYBOARD_KEYS.ENTER && handleToggle()
        }
      >
        {/* Left: collapse chevron (desktop) OR collapse-to-sidebar arrow (mobile fullwidth) */}
        {!isMobileMode && (
          <Icon
            name="chevron-right"
            className="text-xs rotate-90 transition-transform duration-150"
          />
        )}
        {onRequestSidebar && (
          <button
            className="flex items-center justify-center w-[20px] h-[20px] rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onRequestSidebar();
            }}
            title="Collapse to sidebar"
            aria-label="Collapse steps to sidebar"
          >
            <Icon name="chevron-left" className="text-xs" />
          </button>
        )}
        <Icon name="list-ordered" className="text-sm ml-1" />
        <span className="text-xs font-semibold uppercase tracking-wide ml-1.5">
          Steps
        </span>
        <div className="flex-1" />
        <span>
          <PromptCounter narrow={isHeaderNarrow} />
        </span>
        {onRequestClose && (
          <ExitButton
            className="ml-1"
            onClick={(e) => {
              e.stopPropagation();
              onRequestClose();
            }}
            title="Close steps"
            aria-label="Close steps panel"
          />
        )}
      </div>

      {/* Step list */}
      <div
        className={`flex-1 overflow-y-auto min-h-0${isLineageReadOnly ? " pointer-events-none opacity-60 select-none" : ""}`}
        role="listbox"
        tabIndex={0}
        onClick={(e) => {
          // Deselect the current step when clicking blank space in the list.
          // Only fire when the click target is this container itself (not a child).
          if (e.target === e.currentTarget) {
            deselect();
          }
        }}
        onContextMenu={(e) => {
          // Only open the paste menu when right-clicking blank background
          // (step items call e.stopPropagation() so they won't bubble here).
          e.preventDefault();
          openPasteToEndMenu(e.clientX, e.clientY);
        }}
        {...bgLongPressHandlers}
        onKeyDown={(e) => {
          if (e.key === KEYBOARD_KEYS.ESCAPE) {
            deselect();
            return;
          }

          if (
            !e.ctrlKey ||
            e.altKey ||
            e.metaKey ||
            e.shiftKey ||
            isEditableClipboardTarget(e.target)
          ) {
            return;
          }

          const key = e.key.toLowerCase();
          if (key === "c") {
            if (selectionTarget.kind !== FINAL_STEP_PHASES.QUEUE) {
              return;
            }
            e.preventDefault();
            handleSelectedStepCopy();
            return;
          }

          if (key === "v") {
            if (
              isExternallyManaged ||
              isLineageReadOnly ||
              !canPasteStep ||
              selectionTarget.kind !== FINAL_STEP_PHASES.QUEUE
            ) {
              return;
            }
            e.preventDefault();
            handleSelectedStepPaste();
          }
        }}
      >
        {steps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
            <p className="text-xs font-medium text-foreground">
              No workflow steps yet
            </p>
            <button
              type="button"
              className="rounded bg-btn-bg px-3 py-1.5 text-xs font-medium text-btn-fg hover:bg-btn-hover"
              onClick={() => sendMessage(MESSAGE_TYPES.NEW_WORKFLOW)}
            >
              Create from Template
            </button>
            <p className="text-xxs text-description-fg">
              Or ask the built-in <code>ctrlyoke-tech-support</code> agent for
              help getting started.
            </p>
            <a
              href="https://ctrlyoke.dev/docs"
              target="_blank"
              rel="noreferrer"
              className="text-xxs text-link-fg hover:underline"
            >
              ctrlyoke.dev/docs
            </a>
          </div>
        ) : (
          <div className="relative py-1">
            {/* Done steps (indices 0..doneStepCount-1).
                doneStepCount is capped at currentStep to guarantee no overlap with
                the pending section (which starts at currentStep). History entries
                are NOT used to further cap doneStepCount: a step should remain
                visible even if its output wasn't captured in the current history
                file (e.g. script step ran in session 1, AI step ran in
                session 2 appended to the same history, or output capture failed). */}
            {(() => {
              const doneStepCount = currentStep;
              return steps.slice(0, doneStepCount).map((step, sliceIdx) => {
                const index = sliceIdx;
                // Any group anchored in the done range renders here as one
                // container, including a group the boundary runs through (see
                // `straddlingParallelGroup`) — its still-pending members are
                // drawn inside it rather than as loose rows further down.
                const group = parallelGroups.find(
                  (candidate) => candidate.startIndex === index
                );
                if (group) return renderParallelGroup(group);
                if (
                  parallelGroups.some(
                    (candidate) =>
                      index > candidate.startIndex &&
                      index <= candidate.endIndex
                  )
                ) {
                  return null;
                }
                const slotNumber = index + 1;
                const status = getPromptStatus(step, index);
                const retryState = retryStates[index];
                const latestOutput = getLatestOutput(index);
                const isSelected =
                  selectionTarget.kind === FINAL_STEP_PHASES.QUEUE &&
                  selectionTarget.index === index;
                const isExecutionTargetLocked =
                  isStepExecutionLocked(
                    step,
                    index,
                    currentStep,
                    executionState
                  ) ||
                  (isExecutionBusy(executionState) && index === currentStep);
                // No group context to resolve: every grouped step, settled or
                // not, is rendered by `ParallelGroupPanel` above.
                const stepColor = resolveStepColor({
                  step,
                  harnessId: getStepHarnessModel(step, status).harnessId,
                  stepIndex: index,
                  stepColorMode: globalSettings.stepColorMode,
                  settings: globalSettings.harnessColors,
                });
                return (
                  <WorkflowStepRowFrame
                    key={`step-${index}-${step.name || ""}`}
                    index={index}
                    slotNumber={slotNumber}
                    status={status}
                    stepColor={stepColor}
                    isCurrent={isStepExecuting(
                      executionState,
                      index,
                      currentStep,
                      activeStepIndices
                    )}
                  >
                    <WorkflowStepRow
                      step={step}
                      stepColorMode={globalSettings.stepColorMode}
                      harnessColorSettings={globalSettings.harnessColors}
                      index={index}
                      slotNumber={slotNumber}
                      currentStep={currentStep}
                      executionState={executionState}
                      status={status}
                      retryState={retryState}
                      latestOutput={latestOutput}
                      liveContextWindow={liveContextWindow?.[index]}
                      isCurrent={isStepExecuting(
                        executionState,
                        index,
                        currentStep,
                        activeStepIndices
                      )}
                      isSelected={isSelected}
                      canSetStartPosition={canChangeStartPosition}
                      startPositionDirection="rewind"
                      setPositionTarget={index}
                      isExecutionTargetLocked={isExecutionTargetLocked}
                      hideBorderBottom={
                        sliceIdx === doneStepCount - 1 &&
                        doneStepCount < steps.length
                      }
                      dimmed
                      getStepHarnessModel={getStepHarnessModel}
                      getStepOverrides={getStepOverrides}
                      onStepClick={handleStepClick}
                      onSetStartPosition={handleSetStartPosition}
                      onOpenContextMenu={openContextMenu}
                    />
                  </WorkflowStepRowFrame>
                );
              });
            })()}

            {/* Sortable pending steps (currentStep..end) — includes current step */}
            <DndContext
              sensors={sensors}
              collisionDetection={collisionDetection}
              onDragStart={handleDragStart}
              onDragMove={handleDragOverlayMove}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext
                items={previewDragState.order}
                strategy={livePreviewSortingStrategy}
              >
                {(() => {
                  return previewDragState.order.map(
                    (containerId, orderIndex) => {
                      const container =
                        previewDragState.containers[containerId];
                      if (!container) return null;
                      if (container.groupId) {
                        const group = parallelGroups.find(
                          (candidate) => candidate.id === container.groupId
                        );
                        return group ? renderParallelGroup(group, true) : null;
                      }

                      const id = container.items[0];
                      if (!id) return null;
                      const index = absoluteIndexFromStepDragId(id);
                      const step = steps[index];
                      if (!step) return null;
                      const isCurrentStep = index === currentStep;
                      const status = getPromptStatus(step, index);
                      const retryState = retryStates[index];
                      const latestOutput = getLatestOutput(index);
                      const isCurrent = isStepExecuting(
                        executionState,
                        index,
                        currentStep,
                        activeStepIndices
                      );
                      const isSelected =
                        selectionTarget.kind === FINAL_STEP_PHASES.QUEUE &&
                        selectionTarget.index === index;
                      const setPositionTarget = index;
                      // From the live preview's own numbering (see
                      // `computeDisplaySlots`) — the row's current rendered
                      // position, not its identity, so it can never collide
                      // with a neighbour's number mid-drag.
                      const slotNumber = resolveSlotNumber(id);
                      const isExecutionTargetLocked =
                        isStepExecutionLocked(
                          step,
                          index,
                          currentStep,
                          executionState
                        ) ||
                        (isExecutionBusy(executionState) && isCurrentStep);
                      return (
                        <SortableWorkflowStepWrapper
                          key={id}
                          id={id}
                          disabled={!canReorder || isExecutionTargetLocked}
                          slotNumber={slotNumber}
                          showPauseBoundaryBefore={
                            isPaused && currentStep > 0 && orderIndex === 0
                          }
                          step={step}
                          index={index}
                          stepColorMode={globalSettings.stepColorMode}
                          currentStep={currentStep}
                          executionState={executionState}
                          status={status}
                          retryState={retryState}
                          latestOutput={latestOutput}
                          liveContextWindow={liveContextWindow?.[index]}
                          isCurrent={isCurrent}
                          isSelected={isSelected}
                          canSetStartPosition={
                            canChangeStartPosition && !isCurrentStep
                          }
                          startPositionDirection="forward"
                          setPositionTarget={setPositionTarget}
                          isExecutionTargetLocked={isExecutionTargetLocked}
                          getStepHarnessModel={getStepHarnessModel}
                          getStepOverrides={getStepOverrides}
                          onStepClick={handleStepClick}
                          onSetStartPosition={handleSetStartPosition}
                          onOpenContextMenu={openContextMenu}
                        />
                      );
                    }
                  );
                })()}
                {showPendingTail && <PendingTailDropSlot />}
              </SortableContext>
              {activeDragId && dragOverlayRect && (
                <div
                  ref={dragOverlayNodeRef}
                  style={{
                    position: "fixed",
                    top: dragOverlayRect.top,
                    left: dragOverlayRect.left,
                    width: dragOverlayRect.width,
                    zIndex: 999,
                    pointerEvents: "none",
                    transform: "translate3d(0px, 0px, 0)",
                  }}
                >
                  {renderDragOverlayContent()}
                </div>
              )}
            </DndContext>
          </div>
        )}
      </div>

      {isPaused &&
        currentStep === steps.length &&
        finalStep &&
        finalStep.enabled !== false && (
          <div className="relative h-0 flex-shrink-0">
            <PauseBoundary />
          </div>
        )}
      <FinalStepFooter
        finalStep={finalStep}
        stepColor={finalStepColor}
        status={finalStepStatus}
        loopCount={finalStepLoopCount}
        phase={finalStepPhase}
        isExpanded={finalStepFooterExpanded}
        isSelected={selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP}
        isReadOnly={finalStepIsReadOnly}
        isSelectionReadOnly={finalStepSelectionIsReadOnly}
        isNarrow={isHeaderNarrow}
        isDisabled={finalStep?.enabled === false}
        onSelect={handleFinalStepSelect}
        onToggleExpanded={toggleFinalStepFooterExpanded}
        onToggleEnabled={handleToggleFinalStepEnabled}
        onContextMenu={openFinalStepContextMenu}
        {...getFinalStepHarnessModel()}
        latestOutput={finalStepLatestOutput}
        overrides={finalStepOverrides}
      />
      {contextMenuPortal}
      {setPositionModal}
      {deleteModal}
      {pasteToEndMenuPortal}
      {finalStepContextMenuPortal}
    </div>
  );
};

WorkflowStepsPanelInner.displayName = "WorkflowStepsPanel";

export const WorkflowStepsPanel = React.memo(WorkflowStepsPanelInner);
