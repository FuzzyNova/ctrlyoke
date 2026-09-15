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

export type WorkflowStepComponentProps = React.ComponentProps<
  typeof WorkflowStepItem
>;
export type WorkflowStepDragHandleProps =
  WorkflowStepComponentProps["dragHandleProps"];

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
  colorGroup?: ParallelGroupDefinition;
  colorGroupMembers?: readonly StepColorGroupMember[];
  offsetInGroup?: number;
  stepColorMode?: StepColorMode;
  harnessColorSettings?: HarnessColorSettings;
  dragHandleProps?: WorkflowStepDragHandleProps;
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
        isScript={isScriptStep(step)}
        dragHandleProps={dragHandleProps}
      />
    );
  }
);

WorkflowStepRow.displayName = "WorkflowStepRow";

/**
 * The chrome every step row in the panel sits in: the identity rail, the slot
 * number column, the running outline, and an optional pause boundary above it.
 *
 * All three row call sites render through this — the sortable pending row, the
 * panel's settled rows, and a parallel group's members. What they did *not*
 * share was invisible until it was a bug: the running outline lived only in
 * the sortable wrapper, so a group member still executing behind the
 * done/pending boundary was drawn with no outline at all.
 */
export function WorkflowStepRowFrame({
  index,
  slotNumber,
  status,
  stepColor,
  isCurrent,
  showPauseBoundaryBefore = false,
  bodyRef,
  bodyStyle,
  children,
}: {
  index: number;
  slotNumber: number;
  status: StepStatus;
  stepColor: string | undefined;
  isCurrent: boolean;
  showPauseBoundaryBefore?: boolean;
  bodyRef?: (node: HTMLElement | null) => void;
  bodyStyle?: React.CSSProperties;
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
        style={stepColor ? { backgroundColor: stepColor } : undefined}
      />
      <div className="flex-shrink-0 w-[26px] flex items-start justify-center pt-2 text-sm text-description-fg select-none">
        {slotNumber}
      </div>
      {isCurrent && <ExecutingStepHighlight />}
      <div ref={bodyRef} style={bodyStyle} className="relative flex-1 min-w-0">
        {children}
      </div>
    </div>
  );
}

export type SortableWrapperProps = Omit<
  WorkflowStepRowProps,
  "dragHandleProps"
> & {
  id: string;
  disabled: boolean;
  slotNumber: number;
  showPauseBoundaryBefore?: boolean;
};

export const SortableWorkflowStepWrapper = React.memo(
  function SortableWorkflowStepWrapper({
    id,
    disabled,
    slotNumber,
    showPauseBoundaryBefore = false,
    ...stepItemProps
  }: SortableWrapperProps) {
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({ id, disabled });
    const style = {
      transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
      transition,
      opacity: isDragging ? 0.5 : 1,
    };
    const harnessModel = stepItemProps.getStepHarnessModel(
      stepItemProps.step,
      stepItemProps.status
    );
    const stepColor = resolveStepColor({
      step: stepItemProps.step,
      harnessId: harnessModel.harnessId,
      stepIndex: stepItemProps.index,
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
        bodyRef={setNodeRef}
        bodyStyle={style}
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
