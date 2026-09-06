import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { triggerPanelAnimation } from "@utils/panelAnimation";
import { ExitButton } from "../shared";
import {
  getStepAccentClass,
  isExecutionBusy,
  isWorkflowRunning,
} from "../../utils/status";
import { getParallelGroupForStep } from "../../utils/outputRows";
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
  absoluteIndexFromStepDragId,
  groupDragId,
  isStepDragId,
  stepDragId,
} from "@utils/dndKit";

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
 */
type PendingDropTarget =
  | {
      kind: typeof PENDING_DROP_TARGET_KINDS.SIBLING;
      orderIndex: number;
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
  if (state.containers[overId]) {
    const orderIndex = state.order.indexOf(overId);
    return orderIndex < 0
      ? undefined
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
  const groupedIndices = new Set(
    parallelGroups
      .filter((group) => group.startIndex >= currentStep)
      .flatMap((group) =>
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
    next.order.splice(
      Math.min(target.orderIndex, next.order.length),
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
 * Whether a drag crosses a parallel-group boundary — the only case that has to
 * be folded into `dragState` while the pointer is still down.
 *
 * Reordering the rendered list mid-drag is the multi-container pattern, and it
 * is actively harmful for a plain top-level move. There is no `DragOverlay`
 * here, so the dragged row is the real row: dnd-kit keeps it under the pointer
 * by subtracting the delta between the active node's *current* measured rect
 * and the one it measured at drag start. That re-measurement is driven by a
 * `MutationObserver`, and re-ordering the list is exactly such a mutation — so
 * for the frames between the reorder and the measurement landing, the row is
 * drawn a whole row-height away from the cursor and then snaps back. The
 * neighbour is worse off: `SortableContext` re-measures its droppables a render
 * later too, so `verticalListSortingStrategy` briefly indexes the *previous*
 * layout's rects by the *new* order and displaces it by a bogus offset. Whether
 * either excursion is visible depends purely on which frame the observers fire
 * on, which is why the same drag looks smooth once and jumps the next time.
 *
 * `verticalListSortingStrategy` is built to displace a *stationary* list with
 * transforms and have the caller commit the move on drop, so that is what a
 * same-level drag now does (see `resolvePendingDragEnd`). Crossing a group
 * boundary has no transform-only equivalent: `over` is then a member id, which
 * belongs to the group's own nested `SortableContext` and not to the outer
 * one, and an outer `overIndex` of -1 makes dnd-kit drop *every* transform —
 * including the one keeping the dragged row under the cursor. Folding the move
 * in is what puts the row into the context that can still animate it.
 *
 * Dragging a whole group is a plain top-level reorder and never mutates: the
 * group's own id is in the outer items, so the strategy can displace around it.
 *
 * A member over its *own* group's slot is deliberately not a crossing. On drop
 * that means "leave the group and take its slot" (see `movePendingDragItem`),
 * but folding it mid-drag is the bounce half of an oscillation: the fold that
 * put the step into the group pushed its row down past the group header, which
 * is enough for the next collision to resolve to the group's own slot, which
 * folds it straight back out. See `handleDragOver` for why that loop is fatal.
 */
export function isParallelGroupDragMove(
  state: PendingDragState,
  activeId: string,
  overId: string
): boolean {
  if (!isStepDragId(activeId)) return false;
  const sourceId = findPendingDragContainer(state, activeId);
  const target = resolvePendingDropTarget(state, overId);
  if (!sourceId || !target) return false;
  if (target.kind === PENDING_DROP_TARGET_KINDS.MEMBER) {
    return target.containerId !== sourceId;
  }
  return (
    Boolean(state.containers[sourceId].groupId) &&
    state.order[target.orderIndex] !== sourceId
  );
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
 * Resolve the outcome of a pending-tail drag, or `undefined` when the drag
 * left the committed topology unchanged.
 *
 * `handleDragOver` has already folded any group crossing into `dragState`, and
 * such a drop lands with the active step and the drop target in the same
 * container. Everything else — a plain top-level reorder, a move inside one
 * parallel group, and dragging a whole group — is applied here, on drop.
 *
 * "Did `dragState` change here?" is therefore the wrong question either way: a
 * drop that merely confirms what `handleDragOver` already applied changes
 * nothing at this point yet still has to be sent. `committedState` (rebuilt
 * from the store) is the only correct baseline.
 */
export function resolvePendingDragEnd(
  dragState: PendingDragState,
  committedState: PendingDragState,
  activeId: string,
  overId: string,
  currentStep: number,
  parallelGroups: ParallelGroupDefinition[]
): { state: PendingDragState; payload: PendingReorderPayload } | undefined {
  let nextState = dragState;
  if (isStepDragId(activeId)) {
    const sourceId = findPendingDragContainer(nextState, activeId);
    const target = resolvePendingDropTarget(nextState, overId);
    // A step whose container already changed was folded in by `handleDragOver`
    // and is rendered where it will land. Re-running the move against the drop
    // target it is now sitting next to would advance it one more slot.
    const wasFoldedIn =
      sourceId !== findPendingDragContainer(committedState, activeId);
    if (sourceId && target) {
      nextState =
        target.kind === PENDING_DROP_TARGET_KINDS.MEMBER &&
        target.containerId === sourceId &&
        !wasFoldedIn
          ? movePendingDragMemberWithinGroup(
              nextState,
              sourceId,
              activeId,
              overId
            )
          : movePendingDragItem(nextState, activeId, overId);
    }
  } else {
    nextState = movePendingDragContainer(nextState, activeId, overId);
  }

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
 * per member row inside it. Because a member's centre is always nearer to the
 * dragged row than the enclosing panel's centre is, plain `closestCenter` can
 * never report the group itself — so every drag over a group resolved to "into
 * this group", and a step could not be placed above a group sitting at the top
 * of the list. A collision on a member whose dragged centre lies outside the
 * members' own band — over the header, or past the last row — is re-pointed at
 * the group, which is both a real top-level slot and, being in the outer
 * `items`, one the sorting strategy can animate around. Only a group that is
 * first or last in the list needs this; anywhere else the neighbouring step is
 * already the nearer collision.
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

    const collisions = closestCenter(args);
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
    if (centerY < firstMemberRect.top || centerY >= lastMemberRect.bottom) {
      return [{ id: target.containerId }, ...collisions];
    }
    return collisions;
  };
}

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
  } = useStepContextMenu({
    isExternallyManaged,
    externalReadOnlyLabel,
    canChangeStartPosition,
    canPasteStep,
    executionState,
    confirmResetOperations: globalSettings.confirmResetOperations,
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
  const canReorder =
    executionState !== EXECUTION_STATES.CANCELLING && reorderableStepCount > 1;
  const [pendingDragState, setPendingDragState] = useState<PendingDragState>(
    () => buildPendingDragState(steps, currentStep, parallelGroups)
  );

  useEffect(() => {
    setPendingDragState(
      buildPendingDragState(steps, currentStep, parallelGroups)
    );
  }, [currentStep, parallelGroups, steps]);

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
            ? pendingDragState.containers[groupDragId(group.id)]?.items
            : undefined
        }
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
      pendingDragState,
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
    | string
    | undefined;

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

  // Compute overrides for the final step (same logic as regular steps)
  const finalStepOverrides = finalStep
    ? getStepOverrides(finalStep)
    : undefined;

  /** Latest drag position dnd-kit measured, or `null` before the first one. */
  const dragPositionRef = useRef<number | null>(null);

  const collisionDetection = useMemo<CollisionDetection>(() => {
    const detect = pendingDragCollisionDetection(pendingDragState);
    return (args) => {
      // `collisionRect` is the drag's *input* position: dnd-kit subtracts the
      // active node's re-measurement delta from the sensor translate, so it
      // resolves to `initialActiveNodeRect + translate` and moves only when a
      // sensor moves. That is the property `handleDragOver` needs and cannot
      // get from its own event — `event.delta` is the modified translate,
      // which shifts by a row height the instant a fold relocates the row's
      // DOM node. Recorded during render because collision detection runs in
      // the render that produces the `over` this drag reacts to; nothing
      // renders off it.
      dragPositionRef.current = args.collisionRect.top;
      return detect(args);
    };
  }, [pendingDragState]);

  /** Drag position at which the last group crossing was folded in. */
  const foldedAtPositionRef = useRef<number | null>(null);

  /** Every drag starts and ends with the fold guard disarmed. */
  const resetFoldGuard = useCallback(() => {
    foldedAtPositionRef.current = null;
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : undefined;
    if (!overId) return;
    // At most one fold per drag position, because a fold can manufacture the
    // `over` change that triggers the next one. Folding moves the dragged
    // row's DOM node into (or out of) a group panel, which reflows the list
    // and makes dnd-kit re-measure every droppable against a drag position
    // that did not move; the new rects can resolve `over` back to the side the
    // row just left, and `onDragOver` fires on every `over` change. Nothing in
    // that cycle needs the user to move, so it spins until React tears the
    // webview down with "Maximum update depth exceeded" (minified #185).
    //
    // Refusing a fold is always safe: it is a preview, and `handleDragEnd`
    // resolves the same outcome from `committedState` whether or not the
    // crossing was folded in. `null` means no collision has been measured
    // (the drag is being driven by a test, or by a sensor that never rendered
    // one), and never suppresses a fold.
    const position = dragPositionRef.current;
    if (position !== null && position === foldedAtPositionRef.current) return;
    foldedAtPositionRef.current = position;
    setPendingDragState((state) =>
      isParallelGroupDragMove(state, activeId, overId)
        ? movePendingDragItem(state, activeId, overId)
        : state
    );
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      foldedAtPositionRef.current = null;
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : undefined;
      if (!overId) return;

      const outcome = resolvePendingDragEnd(
        pendingDragState,
        buildPendingDragState(steps, currentStep, parallelGroups),
        activeId,
        overId,
        currentStep,
        parallelGroups
      );
      if (!outcome) return;
      setPendingDragState(outcome.state);
      sendMessage(MESSAGE_TYPES.REORDER_PROMPTS, outcome.payload);

      const editorStore = useEditorStore.getState();
      if (editorStore.selectionTarget.kind === FINAL_STEP_PHASES.QUEUE) {
        editorStore.cancelEdit();
      }
    },
    [currentStep, parallelGroups, pendingDragState, steps]
  );

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
    <div className="flex flex-col h-full bg-editor-bg select-none [-webkit-touch-callout:none]">
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
          <i className="codicon codicon-chevron-right text-xs rotate-90 transition-transform duration-150" />
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
            <i className="codicon codicon-chevron-left text-xs" />
          </button>
        )}
        <i className="codicon codicon-list-ordered text-sm ml-1" />
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
                const group = parallelGroups.find(
                  (candidate) =>
                    candidate.startIndex === index &&
                    candidate.endIndex < doneStepCount
                );
                if (group) return renderParallelGroup(group);
                if (
                  parallelGroups.some(
                    (candidate) =>
                      candidate.endIndex < doneStepCount &&
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
                // A group only renders through ParallelGroupPanel once every
                // member is done. While it is still finishing, its completed
                // members fall through to this branch, so the group context has
                // to be supplied here too — otherwise a member resolves to its
                // bare harness colour here while the output pane, which always
                // has the group, resolves the same step to a tie-break colour.
                const colorGroup = getParallelGroupForStep(
                  parallelGroups,
                  index
                );
                const colorGroupMembers: StepColorGroupMember[] | undefined =
                  colorGroup
                    ? steps
                        .slice(colorGroup.startIndex, colorGroup.endIndex + 1)
                        .map((member, offsetInGroup) => ({
                          step: member,
                          harnessId: getStepHarnessModel(
                            member,
                            getPromptStatus(
                              member,
                              colorGroup.startIndex + offsetInGroup
                            )
                          ).harnessId,
                          offsetInGroup,
                        }))
                    : undefined;
                const stepColor = resolveStepColor({
                  step,
                  harnessId: getStepHarnessModel(step, status).harnessId,
                  stepColorMode: globalSettings.stepColorMode,
                  settings: globalSettings.harnessColors,
                  group: colorGroup,
                  offsetInGroup: colorGroup
                    ? index - colorGroup.startIndex
                    : undefined,
                  groupMembers: colorGroupMembers,
                });
                return (
                  <div
                    key={`step-${index}-${step.name || ""}`}
                    className="relative flex items-stretch"
                    data-workflow-step-index={index}
                  >
                    {/* Keep the identity rail separate from the consistently sized number column. */}
                    <div
                      className={`w-[2px] flex-shrink-0 self-stretch ${stepColor ? "" : getStepAccentClass(status)}`}
                      style={
                        stepColor ? { backgroundColor: stepColor } : undefined
                      }
                    />
                    <div className="flex-shrink-0 w-[26px] flex items-start justify-center pt-2 text-sm text-description-fg select-none">
                      {slotNumber}
                    </div>
                    <div className="flex-1 min-w-0">
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
                        isCurrent={false}
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
                    </div>
                  </div>
                );
              });
            })()}

            {/* Sortable pending steps (currentStep..end) — includes current step */}
            <DndContext
              sensors={sensors}
              collisionDetection={collisionDetection}
              onDragStart={resetFoldGuard}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onDragCancel={resetFoldGuard}
            >
              <SortableContext
                items={pendingDragState.order}
                strategy={verticalListSortingStrategy}
              >
                {(() => {
                  let pendingOffset = 0;
                  return pendingDragState.order.map((containerId) => {
                    const container = pendingDragState.containers[containerId];
                    if (!container) return null;
                    if (container.groupId) {
                      pendingOffset += container.items.length;
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
                    const visualIdx = pendingOffset++;
                    const isCurrentStep = visualIdx === 0;
                    const status = getPromptStatus(step, index);
                    const retryState = retryStates[index];
                    const latestOutput = getLatestOutput(index);
                    const isCurrent = isRunning && isCurrentStep;
                    const isSelected =
                      selectionTarget.kind === FINAL_STEP_PHASES.QUEUE &&
                      selectionTarget.index === index;
                    const setPositionTarget = currentStep + visualIdx;
                    const slotNumber = currentStep + visualIdx + 1;
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
                          isPaused && currentStep > 0 && visualIdx === 0
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
                  });
                })()}
              </SortableContext>
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
      {pasteToEndMenuPortal}
      {finalStepContextMenuPortal}
    </div>
  );
};

WorkflowStepsPanelInner.displayName = "WorkflowStepsPanel";

export const WorkflowStepsPanel = React.memo(WorkflowStepsPanelInner);
