import {
  BULK_EDIT_DISABLED_REASONS,
  EXECUTION_STATES,
  STEP_TYPES,
  type ExecutionState,
} from "@root/types/DashboardConstants";
import type { ParallelGroupDefinition } from "@root/types/CtrlYokeTypes";
import type { WorkflowStep } from "@store/workflowStore";
import { isWorkflowActive } from "./status";

export interface StepCapabilities {
  canEditColor: boolean;
  canToggleEnabled: boolean;
  canDelete: boolean;
  canReorder: boolean;
  canEditPromptProperties: boolean;
}

export const STEP_CAPABILITY_ACTIONS = {
  EDIT: "edit",
  DELETE: "delete",
  REORDER: "reorder",
  TOGGLE: "toggle",
} as const;
export type StepCapabilityAction =
  (typeof STEP_CAPABILITY_ACTIONS)[keyof typeof STEP_CAPABILITY_ACTIONS];

export interface StepCapabilityContext {
  currentStep: number;
  executionState: ExecutionState;
  pendingRewindBoundary?: number;
  isExternallyManaged?: boolean;
  /** The caller knows this is the active execution target, including legacy runtime data. */
  isExecutionTargetLocked?: boolean;
  totalSteps?: number;
  parallelGroups?: readonly ParallelGroupDefinition[];
}

export function hasTerminalStepRuntime(step: WorkflowStep): boolean {
  return step._runtime?.completedAt !== undefined;
}

/** Matches the row-lock rule used by the step list and compact chip rail. */
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

function isParallelGroupMember(
  index: number,
  groups: readonly ParallelGroupDefinition[] = []
): boolean {
  return groups.some(
    (group) => index >= group.startIndex && index <= group.endIndex
  );
}

export function getStepCapabilities(
  step: WorkflowStep,
  index: number,
  ctx: StepCapabilityContext
): StepCapabilities {
  const runtime = step._runtime;
  const terminalRuntime =
    runtime !== undefined &&
    (("terminalStatus" in runtime && runtime.terminalStatus !== undefined) ||
      runtime.completedAt !== undefined);
  // RunContinuationService permanently protects the executed prefix and terminal
  // statuses. PromptQueue also protects the completed prefix while executing.
  const hostLocked =
    index < ctx.currentStep ||
    terminalRuntime ||
    isStepExecutionLocked(step, index, ctx.currentStep, ctx.executionState) ||
    (ctx.pendingRewindBoundary !== undefined &&
      index < ctx.pendingRewindBoundary);
  const executingTarget = Boolean(ctx.isExecutionTargetLocked);
  const canMutate =
    index >= 0 && !ctx.isExternallyManaged && !hostLocked && !executingTarget;
  const isPrompt = step.type !== STEP_TYPES.SCRIPT;

  return {
    // Color has its own cosmetic update path and is allowed on locked steps.
    canEditColor: index >= 0,
    canToggleEnabled: canMutate,
    canDelete: canMutate,
    canReorder:
      canMutate &&
      index < (ctx.totalSteps ?? Number.POSITIVE_INFINITY) &&
      ctx.executionState !== EXECUTION_STATES.CANCELLING,
    canEditPromptProperties: canMutate && isPrompt,
  };
}

export function getSelectionCapabilities(
  indices: readonly number[],
  steps: readonly WorkflowStep[],
  ctx: StepCapabilityContext
): StepCapabilities {
  if (indices.length === 0) {
    return {
      canEditColor: false,
      canToggleEnabled: false,
      canDelete: false,
      canReorder: false,
      canEditPromptProperties: false,
    };
  }

  const capabilities = indices.map((index) => {
    const step = steps[index];
    return step
      ? getStepCapabilities(step, index, ctx)
      : {
          canEditColor: false,
          canToggleEnabled: false,
          canDelete: false,
          canReorder: false,
          canEditPromptProperties: false,
        };
  });
  const reduce = (key: keyof StepCapabilities) =>
    capabilities.every((capability) => capability[key]);
  const containsParallelMember = indices.some((index) =>
    isParallelGroupMember(index, ctx.parallelGroups)
  );
  return {
    canEditColor: reduce("canEditColor"),
    canToggleEnabled: reduce("canToggleEnabled"),
    canDelete: reduce("canDelete"),
    canReorder: reduce("canReorder") && !containsParallelMember,
    canEditPromptProperties: reduce("canEditPromptProperties"),
  };
}

export function getStepCapabilityDisabledReason(
  ctx: StepCapabilityContext,
  action: StepCapabilityAction,
  index: number,
  step?: WorkflowStep
): string | undefined {
  if (ctx.isExternallyManaged) return "Read-only — external workflow";
  if (
    ctx.pendingRewindBoundary !== undefined &&
    index < ctx.pendingRewindBoundary
  ) {
    return "Cannot change a preserved step while a continuation is pending";
  }
  if (ctx.isExecutionTargetLocked) {
    return action === STEP_CAPABILITY_ACTIONS.REORDER
      ? "Cannot move the currently executing step"
      : "Cannot change the currently executing step";
  }
  if (
    index < ctx.currentStep ||
    (step &&
      ((step._runtime !== undefined &&
        "terminalStatus" in step._runtime &&
        step._runtime.terminalStatus !== undefined) ||
        isStepExecutionLocked(
          step,
          index,
          ctx.currentStep,
          ctx.executionState
        )))
  ) {
    return "Cannot change a completed step";
  }
  if (ctx.executionState === EXECUTION_STATES.CANCELLING) {
    return action === STEP_CAPABILITY_ACTIONS.REORDER
      ? "Cannot reorder steps while workflow is cancelling"
      : "Cannot change steps while workflow is cancelling";
  }
  return undefined;
}

/** First selected index whose own capabilities deny `key`, if any. */
export function findSelectedIndexLacking(
  indices: readonly number[],
  steps: readonly WorkflowStep[],
  ctx: StepCapabilityContext,
  key: keyof StepCapabilities
): number | undefined {
  return indices.find((index) => {
    const step = steps[index];
    return !step || !getStepCapabilities(step, index, ctx)[key];
  });
}

/**
 * Why a multi-selection cannot have its prompt properties edited, or
 * undefined when it can. Locked steps win over the prompts-only rule because
 * removing them is the fix the user needs first.
 */
export function getBulkPromptPropertyDisabledReason(
  indices: readonly number[],
  steps: readonly WorkflowStep[],
  ctx: StepCapabilityContext
): string | undefined {
  if (getSelectionCapabilities(indices, steps, ctx).canEditPromptProperties) {
    return undefined;
  }
  return findSelectedIndexLacking(indices, steps, ctx, "canToggleEnabled") !==
    undefined
    ? BULK_EDIT_DISABLED_REASONS.LOCKED_STEPS
    : BULK_EDIT_DISABLED_REASONS.PROMPTS_ONLY;
}
