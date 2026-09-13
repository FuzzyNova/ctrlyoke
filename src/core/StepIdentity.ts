import { randomUUID } from "crypto";
import type { WorkflowStep } from "../types/CtrlYokeTypes";

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
  const usedIds = new Set<string>();
  const identified = steps.map((step, index) => {
    const existingId = step._runtime?.stepId;
    if (existingId !== undefined && existingId.length > 0) {
      usedIds.add(existingId);
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

/** Clear execution metadata during rewind without changing step identity. */
export function resetStepRuntimeForRewind(step: WorkflowStep): WorkflowStep {
  const stepId = step._runtime?.stepId;
  const { _runtime: _omitted, ...definition } = step;
  return stepId === undefined
    ? definition
    : { ...definition, _runtime: { stepId } };
}
