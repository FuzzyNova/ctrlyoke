import { randomUUID } from "crypto";
import type { WorkflowStep } from "../types/CtrlYokeTypes";
import { hasStarted } from "../utils/StepStatusDerivation";

/** Shared mutation diagnostics so every workflow mutation path reports the same policy. */
export const STEP_MUTATION_ERROR_MESSAGES = {
  completed: (operation: string) =>
    `Cannot ${operation} a completed step while the workflow is running`,
  started: (operation: string) =>
    `Cannot ${operation} the currently executing step: the step has already started`,
  shiftedStartedStep: (operation: string, stepId: string) =>
    `Cannot ${operation} the started step ${stepId}: started step positions must remain fixed`,
} as const;

/** Reject a direct mutation of a step that has already entered execution. */
export function assertStepMutable(
  step: WorkflowStep | undefined,
  operation: string,
  position?: "completedPrefix"
): void {
  if (!hasStarted(step)) {
    return;
  }
  throw new Error(
    position === "completedPrefix" || step?._runtime?.completedAt !== undefined
      ? STEP_MUTATION_ERROR_MESSAGES.completed(operation)
      : STEP_MUTATION_ERROR_MESSAGES.started(operation)
  );
}

/**
 * Started steps are absolute-index anchors. Definition edits may change the
 * pending topology, but may never move, remove, or replace an anchor at a
 * different position.
 */
export function assertStartedStepPositionsPreserved(
  before: readonly WorkflowStep[],
  after: readonly WorkflowStep[],
  operation: string
): void {
  for (const [index, step] of before.entries()) {
    if (!hasStarted(step)) {
      continue;
    }
    const stepId = step._runtime?.stepId;
    const preserved =
      stepId !== undefined && stepId.length > 0
        ? after[index]?._runtime?.stepId === stepId
        : after[index] === step;
    if (!preserved) {
      throw new Error(
        step._runtime?.completedAt !== undefined
          ? STEP_MUTATION_ERROR_MESSAGES.completed(operation)
          : stepId === undefined
            ? STEP_MUTATION_ERROR_MESSAGES.started(operation)
            : STEP_MUTATION_ERROR_MESSAGES.shiftedStartedStep(operation, stepId)
      );
    }
  }
}

/** Generate a run-local step identity that is not already in the supplied set. */
export function generateStepId(
  existingIds: ReadonlySet<string> = new Set()
): string {
  let stepId = randomUUID();
  while (existingIds.has(stepId)) {
    stepId = randomUUID();
  }
  return stepId;
}

/**
 * Validate the identities present in a step array. Missing IDs are permitted
 * for backwards-compatible reads; `ensureStepIds` makes a working run complete.
 */
export function validateUniqueStepIds(steps: readonly WorkflowStep[]): void {
  const seen = new Set<string>();
  for (const [index, step] of steps.entries()) {
    const stepId = step._runtime?.stepId;
    if (stepId === undefined || stepId.length === 0) {
      continue;
    }
    if (seen.has(stepId)) {
      throw new Error(`Duplicate stepId "${stepId}" at index ${index}`);
    }
    seen.add(stepId);
  }
}

/** Ensure every queue step has an identity while preserving existing metadata. */
export function ensureStepIds(
  steps: readonly WorkflowStep[],
  fallbackSteps?: readonly WorkflowStep[]
): WorkflowStep[] {
  validateUniqueStepIds(steps);
  const usedIds = new Set<string>(
    steps
      .map((step) => step._runtime?.stepId)
      .filter(
        (stepId): stepId is string => stepId !== undefined && stepId.length > 0
      )
  );
  const identified = steps.map((step, index) => {
    const existingId = step._runtime?.stepId;
    if (existingId !== undefined && existingId.length > 0) {
      return step;
    }

    const fallbackId = fallbackSteps?.[index]?._runtime?.stepId;
    const stepId =
      fallbackId !== undefined && !usedIds.has(fallbackId)
        ? fallbackId
        : generateStepId(usedIds);
    usedIds.add(stepId);
    return {
      ...step,
      _runtime: {
        ...step._runtime,
        stepId,
      },
    };
  });

  validateUniqueStepIds(identified);
  return identified;
}

/** Resolve a run-scoped step identity to its current array position. */
export function findStepIndexById(
  steps: readonly WorkflowStep[],
  stepId: string
): number {
  return steps.findIndex((step) => step._runtime?.stepId === stepId);
}

/** Resolve a step by its durable identity, independent of its current position. */
export function findStepById(
  steps: readonly WorkflowStep[],
  stepId: string | undefined
): WorkflowStep | undefined {
  if (stepId === undefined || stepId.length === 0) {
    return undefined;
  }
  const index = findStepIndexById(steps, stepId);
  return index === -1 ? undefined : steps[index];
}

/** Clear execution metadata during rewind without changing step identity. */
export function resetStepRuntimeForRewind(step: WorkflowStep): WorkflowStep {
  const stepId = step._runtime?.stepId;
  const { _runtime: _omitted, ...definition } = step;
  return stepId === undefined
    ? definition
    : { ...definition, _runtime: { stepId } };
}
