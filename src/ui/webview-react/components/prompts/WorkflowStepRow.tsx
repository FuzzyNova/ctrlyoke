import React, { useCallback } from "react";
import { useSortable } from "@dnd-kit/sortable";
import {
  EXECUTION_STATES,
  STEP_STATUS,
  STEP_TYPES,
} from "@root/types/DashboardConstants";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";
import type { ExecutionState, StepStatus } from "../../types/messages";
import {
  WorkflowStepItem,
  type PromptOverride,
  type StepDetails,
} from "./WorkflowStep";
import type { WorkflowStep } from "@store/workflowStore";
import {
  ExecutingStepHighlight,
  PauseBoundary,
} from "./ExecutingStepHighlight";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { HarnessColorSettings } from "@root/types/CtrlYokeSettings";
import type { StepColorMode } from "@root/types/DashboardConstants";
import { resolveStepColor, type StepColorGroupMember } from "@utils/stepColor";
import { getStepAccentClass } from "@utils/status";
import { type WorkflowStepDragHandleProps } from "@utils/dndKit";

export type WorkflowStepComponentProps = React.ComponentProps<
  typeof WorkflowStepItem
>;
export type { WorkflowStepDragHandleProps };

export type StepHarnessModel = Pick<
  WorkflowStepComponentProps,
  | "harnessId"
  | "harnessLabel"
  | "harnessIsDefault"
  | "modelLabel"
  | "modelIsDefault"
>;

export type StepContextMenuRequest = {
  step: WorkflowStep;
  setPositionTarget: number;
  deleteIndex: number;
  isCurrentStep: boolean;
  isExecutionTargetLocked: boolean;
  direction: "rewind" | "forward";
  outputText?: string;
  latestOutput?: WorkflowStepComponentProps["latestOutput"];
  runtimeMeta?: WorkflowStepComponentProps["runtimeMeta"];
  liveContextWindow?: WorkflowStepComponentProps["liveContextWindow"];
};

export type WorkflowStepRowProps = {
  step: WorkflowStep;
  index: number;
  slotNumber: number;
  currentStep: number;
  executionState: ExecutionState;
  status: StepStatus;
  retryState?: WorkflowStepComponentProps["retryState"];
  latestOutput?: WorkflowStepComponentProps["latestOutput"];
  liveContextWindow?: WorkflowStepComponentProps["liveContextWindow"];
  isCurrent: boolean;
  isSelected: boolean;
  canSetStartPosition: boolean;
  startPositionDirection: "rewind" | "forward";
  setPositionTarget: number;
  isExecutionTargetLocked: boolean;
  hideBorderBottom?: boolean;
  dimmed?: boolean;
  dragHandleProps?: WorkflowStepDragHandleProps;
  colorGroup?: ParallelGroupDefinition;
  colorGroupMembers?: readonly StepColorGroupMember[];
  offsetInGroup?: number;
  stepColorMode?: StepColorMode;
  harnessColorSettings?: HarnessColorSettings;
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
};

function isScriptStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
}

function getStepText(step: WorkflowStep): string {
  return isScriptStep(step) ? step.script : step.prompt;
}

/**
 * Shared row renderer for ordinary steps and parallel-group members.
 */
export const WorkflowStepRow = React.memo<WorkflowStepRowProps>(
  ({
    step,
    index,
    slotNumber,
    currentStep,
    executionState,
    status,
    retryState,
    latestOutput,
    liveContextWindow,
    isCurrent,
    isSelected,
    canSetStartPosition,
    startPositionDirection,
    setPositionTarget,
    isExecutionTargetLocked,
    hideBorderBottom = false,
    dimmed = false,
    dragHandleProps,
    getStepHarnessModel,
    getStepOverrides,
    onStepClick,
    onSetStartPosition,
    onOpenContextMenu,
  }) => {
    const harnessModel = getStepHarnessModel(step, status);
    const overrides = getStepOverrides(step);
    const details: StepDetails = {};

    if (latestOutput?.elapsed) {
      details.duration = latestOutput.elapsed;
    }
    const workflowContinuedAfterFailure =
      status === STEP_STATUS.FAILED &&
      index < currentStep &&
      (executionState !== EXECUTION_STATES.ERROR || index < currentStep - 1);
    if (workflowContinuedAfterFailure) {
      const failureMessage = !isScriptStep(step)
        ? step._runtime?.failureMessage
        : undefined;
      details.message = failureMessage
        ? `Workflow continued after failure: ${failureMessage}`
        : "Workflow continued after this step failed.";
    }

    const outputText = latestOutput?.response as string | undefined;
    const handleContextMenu = useCallback(
      (x: number, y: number) =>
        onOpenContextMenu(x, y, {
          step,
          setPositionTarget,
          deleteIndex: index,
          isCurrentStep: isCurrent,
          isExecutionTargetLocked,
          direction: startPositionDirection,
          outputText,
          latestOutput,
          runtimeMeta: !isScriptStep(step) ? step._runtime : undefined,
          liveContextWindow,
        }),
      [
        index,
        isCurrent,
        isExecutionTargetLocked,
        latestOutput,
        liveContextWindow,
        onOpenContextMenu,
        outputText,
        setPositionTarget,
        startPositionDirection,
        step,
      ]
    );

    return (
      <WorkflowStepItem
        text={getStepText(step)}
        index={index}
        displayNumber={slotNumber}
        name={step.name}
        status={status}
        retryState={retryState}
        details={details}
        latestOutput={latestOutput}
        liveContextWindow={liveContextWindow}
        runtimeMeta={step._runtime}
        isDisabled={step.enabled === false}
        isCurrent={isCurrent}
        isSelected={isSelected}
        onClick={() => onStepClick(index)}
        harnessId={harnessModel.harnessId}
        harnessLabel={harnessModel.harnessLabel}
        harnessIsDefault={harnessModel.harnessIsDefault}
        modelLabel={harnessModel.modelLabel}
        modelIsDefault={harnessModel.modelIsDefault}
        overrides={overrides}
        canSetStartPosition={canSetStartPosition}
        startPositionDirection={startPositionDirection}
        onSetStartPosition={() => onSetStartPosition(setPositionTarget)}
        onContextMenu={handleContextMenu}
        hideBorderBottom={hideBorderBottom}
        dimmed={dimmed}
        dragHandleProps={dragHandleProps}
        isScript={isScriptStep(step)}
      />
    );
  }
);

WorkflowStepRow.displayName = "WorkflowStepRow";

/**
 * The chrome every step row in the panel sits in: the identity rail, the slot
 * number column, the running outline, and an optional pause boundary above
 * it. The drag handle is deliberately NOT part of this frame — `dragHandleProps`
 * is instead forwarded through `WorkflowStepRow` to `WorkflowStepItem`, which
 * renders the handle as the trailing item inside its own styled container.
 * That is what gives the handle the same hover background and bottom border
 * as the rest of the step, instead of living in an unstyled column beside it.
 *
 * All three row call sites render through this — the sortable pending row, the
 * panel's settled rows, and a parallel group's members. What they did *not*
 * share was invisible until it was a bug: the running outline lived only in
 * the sortable wrapper, so a group member still executing behind the
 * done/pending boundary was drawn with no outline at all.
 *
 * `displacementStyle` is how a drag displacement reaches the rail and number
 * columns. It has to be applied to each of the three columns *separately*,
 * never to this wrapper, because the body is the element dnd-kit registers as
 * a droppable and it measures droppables with `getTransformAgnosticClientRect`
 * — which inverts an element's **own** computed transform and nothing else. A
 * transform on the wrapper is an *ancestor* transform to the body, so it stays
 * baked into `getBoundingClientRect()` and silently shifts every measured rect
 * the collision rules depend on. Hoisting it here would be the obvious tidy-up
 * and it would break dragging outright, which is exactly why it is spelled out.
 */
export function WorkflowStepRowFrame({
  index,
  slotNumber,
  status,
  stepColor,
  isCurrent,
  showPauseBoundaryBefore = false,
  hideExecutingHighlight = false,
  bodyRef,
  bodyStyle,
  displacementStyle,
  children,
}: {
  index: number;
  slotNumber: number;
  status: StepStatus;
  stepColor: string | undefined;
  isCurrent: boolean;
  showPauseBoundaryBefore?: boolean;
  /**
   * Suppresses this row's own running outline. Set by `ParallelGroupPanel`
   * for its members — a running group draws one outline around the whole
   * group instead of one per member, so a member row drawing its own on top
   * would double up on the group's edges.
   */
  hideExecutingHighlight?: boolean;
  bodyRef?: (node: HTMLElement | null) => void;
  bodyStyle?: React.CSSProperties;
  /**
   * The row's current drag displacement (`transform`/`transition` only), also
   * applied to the rail and number so the whole row travels as one piece.
   */
  displacementStyle?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div
      className="relative flex items-stretch"
      data-workflow-step-index={index}
    >
      {showPauseBoundaryBefore && <PauseBoundary />}
      {/* Keep the identity rail separate from the consistently sized number column. */}
      <div
        className={`w-[2px] flex-shrink-0 self-stretch ${stepColor ? "" : getStepAccentClass(status)}`}
        style={
          stepColor
            ? { backgroundColor: stepColor, ...displacementStyle }
            : displacementStyle
        }
      />
      <div
        className="flex-shrink-0 w-[26px] flex items-start justify-center pt-2 text-sm text-description-fg select-none"
        style={displacementStyle}
      >
        {slotNumber}
      </div>
      {isCurrent && !hideExecutingHighlight && <ExecutingStepHighlight />}
      <div ref={bodyRef} style={bodyStyle} className="relative flex-1 min-w-0">
        {children}
      </div>
    </div>
  );
}

export type SortableWrapperProps = WorkflowStepRowProps & {
  id: string;
  disabled: boolean;
  slotNumber: number;
  showPauseBoundaryBefore?: boolean;
  /** See `WorkflowStepRowFrame`'s prop of the same name. */
  hideExecutingHighlight?: boolean;
};

export const SortableWorkflowStepWrapper = React.memo(
  function SortableWorkflowStepWrapper({
    id,
    disabled,
    slotNumber,
    showPauseBoundaryBefore = false,
    hideExecutingHighlight = false,
    ...stepItemProps
  }: SortableWrapperProps) {
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isSorting,
      isDragging,
    } = useSortable({ id, disabled });
    // The transition is kept only while a drag is actually in flight. dnd-kit
    // drops `transform` to null the instant the drag ends, and hands back the
    // 200ms transform transition in that very same render — `getTransition`
    // falls through to `shouldAnimateLayoutChanges`, which outlives the drag by
    // ~50ms. The row therefore animates from its discarded displacement back to
    // the slot the live preview had already put it in: the drop visibly flying
    // back instead of landing. It is intermittent because that flag hinges on
    // the item/index bookkeeping of the particular drop. Gating on `isSorting`
    // leaves the in-drag slide untouched and makes the release itself instant.
    const displacementStyle = {
      transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
      transition: isSorting ? transition : undefined,
    };
    const style = { ...displacementStyle, opacity: isDragging ? 0.5 : 1 };
    const harnessModel = stepItemProps.getStepHarnessModel(
      stepItemProps.step,
      stepItemProps.status
    );
    const stepColor = resolveStepColor({
      step: stepItemProps.step,
      harnessId: harnessModel.harnessId,
      // Slot-based, not identity-based: `slotNumber` is the row's current
      // live position (see WorkflowStepsPanel's preview-state numbering), so
      // a unique-mode color tracks where the step is now, not where it
      // started the drag.
      stepIndex: slotNumber - 1,
      group: stepItemProps.colorGroup,
      offsetInGroup: stepItemProps.offsetInGroup,
      stepColorMode: stepItemProps.stepColorMode,
      settings: stepItemProps.harnessColorSettings,
      groupMembers: stepItemProps.colorGroupMembers,
    });
    return (
      <WorkflowStepRowFrame
        index={stepItemProps.index}
        slotNumber={slotNumber}
        status={stepItemProps.status}
        stepColor={stepColor}
        isCurrent={stepItemProps.isCurrent}
        showPauseBoundaryBefore={showPauseBoundaryBefore}
        hideExecutingHighlight={hideExecutingHighlight}
        bodyRef={setNodeRef}
        bodyStyle={style}
        displacementStyle={displacementStyle}
      >
        <WorkflowStepRow
          {...stepItemProps}
          slotNumber={slotNumber}
          dragHandleProps={disabled ? undefined : { listeners, attributes }}
        />
      </WorkflowStepRowFrame>
    );
  }
);

SortableWorkflowStepWrapper.displayName = "SortableWorkflowStepWrapper";
