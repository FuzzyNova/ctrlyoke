import React, { useMemo } from "react";
import {
  PARALLEL_GROUP_FAN_OUT_ENABLED,
  STEP_STATUS,
  type ExecutionState,
  type StepStatus,
} from "@root/types/DashboardConstants";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { WorkflowStep } from "@store/workflowStore";
import {
  WorkflowStepRow,
  type StepContextMenuRequest,
  type StepHarnessModel,
} from "./WorkflowStepRow";
import type { PromptOverride } from "./WorkflowStep";
import type { WorkflowStepComponentProps } from "./WorkflowStepRow";
import {
  getStepAccentClass,
  isWorkflowActive,
  isWorkflowRunning,
} from "@utils/status";

export type ParallelGroupStatus =
  | "running"
  | "failed"
  | "cancelled"
  | "completed"
  | "skipped"
  | "pending";

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
};

export const ParallelGroupPanel: React.FC<ParallelGroupPanelProps> = ({
  group,
  steps,
  currentStep,
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
}) => {
  const members = useMemo(
    () =>
      steps.slice(group.startIndex, group.endIndex + 1).map((step, offset) => ({
        step,
        index: group.startIndex + offset,
        status: statuses[offset] ?? STEP_STATUS.PENDING,
      })),
    [group.endIndex, group.startIndex, steps, statuses]
  );
  const status = deriveParallelGroupStatus(
    members.map(({ step, status }) => ({
      status,
      enabled: step.enabled !== false,
    }))
  );

  return (
    <section
      className="mx-1 my-1 overflow-hidden rounded border border-panel-border bg-sidebar-bg"
      data-testid={`parallel-group-${group.id}`}
      aria-label={`Parallel steps ${group.startIndex + 1} to ${group.endIndex + 1}`}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-panel-border px-2 py-1.5 text-xs">
        <i className="codicon codicon-type-hierarchy text-description-fg" />
        <span className="font-semibold">
          Parallel steps {group.startIndex + 1}–{group.endIndex + 1}
        </span>
        <span
          className="rounded bg-editor-bg px-1.5 py-0.5 uppercase tracking-wide text-description-fg"
          data-testid="parallel-group-status"
        >
          {status}
        </span>
        <label className="ml-auto flex items-center gap-1 text-description-fg">
          <input
            type="checkbox"
            checked={group.failFast}
            onChange={(event) => onFailFastChange(group, event.target.checked)}
            aria-label="Fail fast"
          />
          fail fast
        </label>
        {!PARALLEL_GROUP_FAN_OUT_ENABLED && (
          <span
            className="basis-full text-xxs text-description-fg"
            data-testid="parallel-group-sequential-label"
          >
            runs sequentially in this build
          </span>
        )}
      </header>
      <div>
        {members.map(({ step, index, status: memberStatus }, offset) => (
          <div
            key={index}
            className="relative flex items-stretch"
            data-workflow-step-index={index}
          >
            <div
              className={`w-[2px] flex-shrink-0 self-stretch ${getStepAccentClass(memberStatus)}`}
            />
            <div className="flex-shrink-0 w-[26px] flex items-start justify-center pt-2 text-sm text-description-fg select-none">
              {index + 1}
            </div>
            <div className="flex-1 min-w-0">
              <WorkflowStepRow
                step={step}
                index={index}
                slotNumber={index + 1}
                currentStep={currentStep}
                executionState={executionState}
                status={memberStatus}
                retryState={retryStates[index]}
                latestOutput={getLatestOutput(index)}
                liveContextWindow={liveContextWindow[index]}
                isCurrent={
                  index === currentStep && isWorkflowRunning(executionState)
                }
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
                hideBorderBottom={offset === members.length - 1}
                dimmed={index < currentStep}
                getStepHarnessModel={getStepHarnessModel}
                getStepOverrides={getStepOverrides}
                onStepClick={onStepClick}
                onSetStartPosition={onSetStartPosition}
                onOpenContextMenu={onOpenContextMenu}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

ParallelGroupPanel.displayName = "ParallelGroupPanel";
