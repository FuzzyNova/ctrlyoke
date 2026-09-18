import React, { useMemo } from "react";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import {
  STEP_STATUS,
  type ExecutionState,
  type StepStatus,
  type StepColorMode,
} from "@root/types/DashboardConstants";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { HarnessColorSettings } from "@root/types/CtrlYokeSettings";
import type { WorkflowStep } from "@store/workflowStore";
import {
  WorkflowStepRow,
  WorkflowStepRowFrame,
  SortableWorkflowStepWrapper,
  type StepContextMenuRequest,
  type StepHarnessModel,
} from "./WorkflowStepRow";
import type { PromptOverride } from "./WorkflowStep";
import type { WorkflowStepComponentProps } from "./WorkflowStepRow";
import { StatusIcon } from "./StatusIcon";
import { ExecutingStepHighlight } from "./ExecutingStepHighlight";
import { getStatusLabel, isStepExecuting, isWorkflowActive } from "@utils/status";
import { resolveStepColor, type StepColorGroupMember } from "@utils/stepColor";
import {
  DRAG_HANDLE_TOUCH_ACTION_STYLE,
  absoluteIndexFromStepDragId,
  groupDragId,
  livePreviewSortingStrategy,
} from "@utils/dndKit";
import { Icon } from "../shared/Icon";

export type ParallelGroupStatus =
  "running" | "failed" | "cancelled" | "completed" | "skipped" | "pending";

/**
 * Single-sourced so the "running" tag used for flow control (below) isn't a
 * bare string-literal comparison — `find-hardcoded-strings.mjs` flags
 * repeated flow-control literals, and other files reuse the spelling
 * "running" for unrelated concepts (step ids, token-total variants).
 */
const PARALLEL_GROUP_RUNNING_STATUS: ParallelGroupStatus = "running";

type GroupMemberStatus = {
  status: StepStatus;
  enabled: boolean;
};

const terminalStatuses: StepStatus[] = [
  STEP_STATUS.COMPLETED,
  STEP_STATUS.FAILED,
  STEP_STATUS.CANCELLED,
  STEP_STATUS.SKIPPED,
];

export function deriveParallelGroupStatus(
  members: GroupMemberStatus[]
): ParallelGroupStatus {
  if (
    members.some(
      ({ status }) =>
        status === STEP_STATUS.RUNNING || status === STEP_STATUS.SENT
    )
  ) {
    return "running";
  }

  const terminal = members.every(({ status }) =>
    terminalStatuses.includes(status)
  );
  if (terminal && members.some(({ status }) => status === STEP_STATUS.FAILED)) {
    return "failed";
  }
  if (
    terminal &&
    members.length > 0 &&
    members.every(({ status }) => status === STEP_STATUS.CANCELLED)
  ) {
    return "cancelled";
  }
  if (
    members.length > 0 &&
    members.every(
      ({ status, enabled }) =>
        enabled === false || status === STEP_STATUS.SKIPPED
    )
  ) {
    return "skipped";
  }
  if (
    terminal &&
    members.length > 0 &&
    members.every(({ status }) => status !== STEP_STATUS.FAILED)
  ) {
    return "completed";
  }
  return "pending";
}

export function hasTerminalStepRuntime(step: WorkflowStep): boolean {
  return step._runtime?.completedAt !== undefined;
}

export function isStepExecutionLocked(
  step: WorkflowStep,
  index: number,
  currentStep: number,
  executionState: ExecutionState
): boolean {
  return (
    isWorkflowActive(executionState) &&
    index >= currentStep &&
    hasTerminalStepRuntime(step)
  );
}

type ParallelGroupPanelProps = {
  group: ParallelGroupDefinition;
  steps: WorkflowStep[];
  currentStep: number;
  activeStepIndices?: readonly number[];
  executionState: ExecutionState;
  statuses: StepStatus[];
  retryStates: Record<number, WorkflowStepComponentProps["retryState"]>;
  liveContextWindow: Record<
    number,
    WorkflowStepComponentProps["liveContextWindow"]
  >;
  selectedIndex?: number;
  canSetStartPosition: boolean;
  getLatestOutput: (
    index: number
  ) => WorkflowStepComponentProps["latestOutput"];
  getStepHarnessModel: (
    step: WorkflowStep,
    status: StepStatus
  ) => StepHarnessModel;
  getStepOverrides: (step: WorkflowStep) => PromptOverride[];
  onStepClick: (index: number) => void;
  onSetStartPosition: (index: number) => void;
  onOpenContextMenu: (
    x: number,
    y: number,
    request: StepContextMenuRequest
  ) => void;
  onFailFastChange: (group: ParallelGroupDefinition, failFast: boolean) => void;
  containerId?: string;
  memberIds?: string[];
  dragDisabled?: boolean;
  stepColorMode?: StepColorMode;
  harnessColorSettings?: HarnessColorSettings;
  /**
   * Resolves a member's live display slot number from its drag id. Supplied
   * by `WorkflowStepsPanel` for the pending/sortable branch, where the whole
   * list's numbering is computed once from the live drag preview so it can
   * never diverge from a sibling's. Falls back to the group-local
   * `group.startIndex + offset` when absent (the static/done-section branch,
   * which is never part of a live drag).
   */
  resolveSlotNumber?: (id: string) => number;
};

export const ParallelGroupPanel: React.FC<ParallelGroupPanelProps> = ({
  group,
  steps,
  currentStep,
  activeStepIndices = [],
  executionState,
  statuses,
  retryStates,
  liveContextWindow,
  selectedIndex,
  canSetStartPosition,
  getLatestOutput,
  getStepHarnessModel,
  getStepOverrides,
  onStepClick,
  onSetStartPosition,
  onOpenContextMenu,
  onFailFastChange,
  containerId,
  memberIds,
  dragDisabled = false,
  stepColorMode,
  harnessColorSettings,
  resolveSlotNumber,
}) => {
  // A group is a sortable sibling of the ungrouped steps around it, so it can
  // be dragged as a unit. Only the pending copy takes part: the done-steps
  // branch renders this panel outside the `DndContext` entirely, where dnd-kit
  // falls back to its inert default context.
  const isSortable = memberIds !== undefined && !dragDisabled;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isSorting,
    isDragging,
  } = useSortable({
    id: containerId ?? groupDragId(group.id),
    disabled: !isSortable,
  });
  const members = useMemo(
    () =>
      steps.slice(group.startIndex, group.endIndex + 1).map((step, offset) => ({
        step,
        index: group.startIndex + offset,
        status: statuses[offset] ?? STEP_STATUS.PENDING,
      })),
    [group.endIndex, group.startIndex, steps, statuses]
  );
  const displayedMembers = useMemo(() => {
    if (!memberIds) return members;
    return memberIds
      .map((id) => absoluteIndexFromStepDragId(id))
      .map((index) => ({
        step: steps[index],
        index,
        status: statuses[index - group.startIndex] ?? STEP_STATUS.PENDING,
      }))
      .filter(
        (
          member
        ): member is {
          step: WorkflowStep;
          index: number;
          status: StepStatus;
        } => member.step !== undefined
      );
  }, [group.startIndex, memberIds, members, statuses, steps]);
  const colorGroupMembers = useMemo<StepColorGroupMember[]>(
    () =>
      displayedMembers.map(({ step, status: memberStatus }, offsetInGroup) => ({
        step,
        harnessId: getStepHarnessModel(step, memberStatus).harnessId,
        offsetInGroup,
      })),
    [displayedMembers, getStepHarnessModel]
  );
  const status = deriveParallelGroupStatus(
    displayedMembers.map(({ step, status }) => ({
      status,
      enabled: step.enabled !== false,
    }))
  );
  const isStepActive = (index: number): boolean =>
    isStepExecuting(executionState, index, currentStep, activeStepIndices);

  return (
    <section
      ref={setNodeRef}
      style={{
        transform: transform
          ? `translate3d(0, ${transform.y}px, 0)`
          : undefined,
        // Only while the drag is in flight — see the matching comment in
        // `SortableWorkflowStepWrapper` for why a transition that outlives the
        // drag animates the drop backwards instead of letting it land.
        transition: isSorting ? transition : undefined,
        opacity: isDragging ? 0.5 : 1,
      }}
      className="group/parallel relative mx-1 my-1 overflow-hidden rounded border border-panel-border bg-sidebar-bg"
      data-testid={`parallel-group-${group.id}`}
      aria-label={`Parallel steps ${group.startIndex + 1} to ${group.endIndex + 1}`}
    >
      {/* One outline around the whole running group, in place of the
          per-member outline a standalone step gets — see the matching
          `hideExecutingHighlight` passed to each member row below. */}
      {status === PARALLEL_GROUP_RUNNING_STATUS && (
        <ExecutingStepHighlight testId="parallel-group-executing-highlight" />
      )}
      <header className="flex flex-wrap items-center gap-2 border-b border-panel-border px-2 py-1.5 text-xs">
        <Icon name="worktree-compact" className="text-description-fg" />
        <span className="font-semibold">
          Parallel steps {group.startIndex + 1}–{group.endIndex + 1}
        </span>
        <span
          className="flex items-center"
          data-testid="parallel-group-status"
          title={getStatusLabel(status as StepStatus)}
        >
          <StatusIcon status={status as StepStatus} />
        </span>
        <label
          className={`flex items-center gap-1 text-description-fg ${dragDisabled ? "cursor-not-allowed" : "cursor-pointer"}`}
          title="Cancel the rest of this group's steps as soon as one fails, instead of letting them finish."
        >
          <input
            type="checkbox"
            checked={group.failFast}
            disabled={dragDisabled}
            onChange={(event) => onFailFastChange(group, event.target.checked)}
            className={`w-3 h-3 accent-focus-border ${dragDisabled ? "cursor-not-allowed" : "cursor-pointer"}`}
          />
          fail fast
        </label>
        {isSortable && (
          <span
            className="ml-auto flex w-4 flex-shrink-0 cursor-grab items-center justify-center text-description-fg opacity-0 transition-opacity hover:text-foreground active:cursor-grabbing group-hover/parallel:opacity-100"
            style={DRAG_HANDLE_TOUCH_ACTION_STYLE}
            {...listeners}
            {...attributes}
            aria-label="Drag to reorder parallel group"
          >
            <Icon name="grabber" className="text-xs" />
          </span>
        )}
      </header>
      <div>
        {memberIds ? (
          <SortableContext
            items={memberIds}
            strategy={livePreviewSortingStrategy}
          >
            {displayedMembers.map(
              ({ step, index, status: memberStatus }, offset) => (
                <SortableWorkflowStepWrapper
                  key={index}
                  id={memberIds[offset]}
                  disabled={
                    dragDisabled ||
                    isStepExecutionLocked(
                      step,
                      index,
                      currentStep,
                      executionState
                    )
                  }
                  // The live preview's own numbering, not the step's identity
                  // index or a group-local offset — `WorkflowStepsPanel`
                  // computes one consistent slot map for the whole pending
                  // list, so a step folded in from outside the group (or a
                  // sibling displaced by one leaving) always shows the number
                  // that matches where it's currently rendered.
                  slotNumber={
                    resolveSlotNumber?.(memberIds[offset]) ??
                    group.startIndex + offset + 1
                  }
                  step={step}
                  index={index}
                  currentStep={currentStep}
                  executionState={executionState}
                  status={memberStatus}
                  retryState={retryStates[index]}
                  latestOutput={getLatestOutput(index)}
                  liveContextWindow={liveContextWindow[index]}
                  isCurrent={isStepActive(index)}
                  isSelected={selectedIndex === index}
                  canSetStartPosition={canSetStartPosition}
                  startPositionDirection={
                    index < currentStep ? "rewind" : "forward"
                  }
                  setPositionTarget={index}
                  isExecutionTargetLocked={isStepExecutionLocked(
                    step,
                    index,
                    currentStep,
                    executionState
                  )}
                  hideBorderBottom={offset === displayedMembers.length - 1}
                  dimmed={index < currentStep}
                  colorGroup={group}
                  colorGroupMembers={colorGroupMembers}
                  offsetInGroup={offset}
                  stepColorMode={stepColorMode}
                  harnessColorSettings={harnessColorSettings}
                  hideExecutingHighlight
                  getStepHarnessModel={getStepHarnessModel}
                  getStepOverrides={getStepOverrides}
                  onStepClick={onStepClick}
                  onSetStartPosition={onSetStartPosition}
                  onOpenContextMenu={onOpenContextMenu}
                />
              )
            )}
          </SortableContext>
        ) : (
          displayedMembers.map(
            ({ step, index, status: memberStatus }, offset) => {
              // Never part of a live drag (this is the done-section render),
              // so the group-local offset always equals the real position.
              const slotNumber = group.startIndex + offset + 1;
              const stepColor = resolveStepColor({
                step,
                harnessId: getStepHarnessModel(step, memberStatus).harnessId,
                stepIndex: slotNumber - 1,
                group,
                offsetInGroup: offset,
                stepColorMode,
                settings: harnessColorSettings,
                groupMembers: colorGroupMembers,
              });
              return (
                <WorkflowStepRowFrame
                  key={index}
                  index={index}
                  slotNumber={slotNumber}
                  status={memberStatus}
                  stepColor={stepColor}
                  isCurrent={isStepActive(index)}
                  hideExecutingHighlight
                >
                  <WorkflowStepRow
                    step={step}
                    index={index}
                    slotNumber={slotNumber}
                    currentStep={currentStep}
                    executionState={executionState}
                    status={memberStatus}
                    retryState={retryStates[index]}
                    latestOutput={getLatestOutput(index)}
                    liveContextWindow={liveContextWindow[index]}
                    isCurrent={isStepActive(index)}
                    isSelected={selectedIndex === index}
                    canSetStartPosition={canSetStartPosition}
                    startPositionDirection={
                      index < currentStep ? "rewind" : "forward"
                    }
                    setPositionTarget={index}
                    isExecutionTargetLocked={isStepExecutionLocked(
                      step,
                      index,
                      currentStep,
                      executionState
                    )}
                    hideBorderBottom={offset === displayedMembers.length - 1}
                    dimmed={index < currentStep}
                    colorGroup={group}
                    colorGroupMembers={colorGroupMembers}
                    offsetInGroup={offset}
                    stepColorMode={stepColorMode}
                    harnessColorSettings={harnessColorSettings}
                    getStepHarnessModel={getStepHarnessModel}
                    getStepOverrides={getStepOverrides}
                    onStepClick={onStepClick}
                    onSetStartPosition={onSetStartPosition}
                    onOpenContextMenu={onOpenContextMenu}
                  />
                </WorkflowStepRowFrame>
              );
            }
          )
        )}
      </div>
    </section>
  );
};

ParallelGroupPanel.displayName = "ParallelGroupPanel";
