import {
  isScriptStep,
  type PromptFile,
  type WorkflowStep,
} from "../types/CtrlYokeTypes";
import { hasStarted } from "../utils/StepStatusDerivation";
import { parseInlinePriorContextRefs } from "../utils/FileReferenceParser";
import { PRIOR_CONTEXT_REFERENCE_KINDS } from "../types/DashboardConstants";

type WorkflowReferenceDefaults = Pick<PromptFile, "priorContext" | "sessionId">;

export interface StepReferenceShiftOptions {
  finalStep?: WorkflowStep;
  /** Workflow-level `priorContext` / `sessionId`, which may name positions too. */
  workflowDefaults?: WorkflowReferenceDefaults;
}

/**
 * Positional references — inline `$step:N` / `$step:summary:N`, numeric
 * `priorContext` lists, and numeric `sessionId` — are authored settings. An
 * insert, move, or removal never rewrites them, on any step or at workflow
 * level: position N always means whatever step is at position N.
 *
 * This only reports which references now resolve to a different step (or to
 * none), so callers can warn. It reports unstarted steps that existed before
 * the change and were not themselves moved, the final step, and workflow-level
 * defaults. New steps were authored against the new layout, and a moved step's
 * references were just placed by its author, so neither is reported; the
 * editor's reference lint still flags any reference that no longer resolves.
 */
export function findShiftedStepReferences(
  oldSteps: readonly WorkflowStep[],
  newSteps: readonly WorkflowStep[],
  options: StepReferenceShiftOptions = {}
): string[] {
  const oldKeys = new Set(oldSteps.map(stepKey));
  const moved = findMovedSteps(oldSteps, newSteps);
  const shifted = (reference: number): boolean => {
    const before = oldSteps[reference - 1];
    if (!before) return false;
    const after = newSteps[reference - 1];
    return !after || stepKey(after) !== stepKey(before);
  };

  const affected: string[] = [];
  newSteps.forEach((step, index) => {
    if (isScriptStep(step) || hasStarted(step)) return;
    if (!oldKeys.has(stepKey(step)) || moved.has(stepKey(step))) return;
    if (stepPositionalReferences(step).some(shifted)) {
      affected.push(describeStep(step, index));
    }
  });
  const { finalStep, workflowDefaults } = options;
  if (
    finalStep &&
    !isScriptStep(finalStep) &&
    stepPositionalReferences(finalStep).some(shifted)
  ) {
    affected.push("Final step");
  }
  if (numericReferences(workflowDefaults?.priorContext).some(shifted)) {
    affected.push("workflow Prior Context");
  }
  if (numericReferences(workflowDefaults?.sessionId).some(shifted)) {
    affected.push("workflow Session");
  }
  return affected;
}

/**
 * The warning to show after a step change whose shifted references
 * {@link findShiftedStepReferences} reported, or `undefined` when none were.
 * The change itself always proceeds.
 */
export function describeShiftedStepReferences(
  change: string,
  affected: readonly string[]
): string | undefined {
  if (affected.length === 0) return undefined;
  return `${change}. Step references in ${affected.join(", ")} now point at a different or missing step; check them.`;
}

export const STEP_REFERENCE_CHANGES = {
  REORDER: "Reordered steps",
} as const;

/** Label for an insertion of `count` steps. */
export function describeStepInsertion(count: number): string {
  return count === 1 ? "Inserted a step" : `Inserted ${count} steps`;
}

/** Spread helper: `{ warning }` only when there is one. */
export function withWarning(warning: string | undefined): {
  warning?: string;
} {
  return warning ? { warning } : {};
}

/** Label for a removal of `removedIndices` (0-based). */
export function describeStepRemoval(removedIndices: readonly number[]): string {
  const label = removedIndices.length === 1 ? "step" : "steps";
  const positions = [...removedIndices]
    .sort((left, right) => left - right)
    .map((index) => index + 1)
    .join(", ");
  return `Removed ${label} ${positions}`;
}

function stepPositionalReferences(step: WorkflowStep): number[] {
  if (isScriptStep(step)) return [];
  const texts = [
    step.prompt,
    step.endCondition?.retryPrompt,
    step.endCondition?.passRetryPrompt,
  ];
  return [
    ...numericReferences(step.sessionId),
    ...numericReferences(step.priorContext),
    ...texts.flatMap((text) =>
      typeof text === "string"
        ? parseInlinePriorContextRefs(text).flatMap((match) =>
            match.ref.kind === PRIOR_CONTEXT_REFERENCE_KINDS.STEP
              ? match.ref.indices
              : []
          )
        : []
    ),
  ];
}

function numericReferences(value: unknown): number[] {
  if (typeof value === "number") return [value];
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number")
    : [];
}

/**
 * Steps whose order relative to the others changed: everything outside the
 * longest run of surviving steps that kept their original relative order.
 * Inserts and removals move nothing.
 */
function findMovedSteps(
  oldSteps: readonly WorkflowStep[],
  newSteps: readonly WorkflowStep[]
): Set<unknown> {
  const oldIndexByKey = new Map(
    oldSteps.map((step, index) => [stepKey(step), index] as const)
  );
  const survivors = newSteps
    .map(stepKey)
    .filter((key) => oldIndexByKey.has(key));
  const order = survivors.map((key) => oldIndexByKey.get(key)!);
  const kept = longestIncreasingSubsequence(order);
  return new Set(survivors.filter((_, position) => !kept.has(position)));
}

/** Positions (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasingSubsequence(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const previous: number[] = new Array<number>(values.length).fill(-1);
  values.forEach((value, position) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]] < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[position] = tails[low - 1];
    tails[low] = position;
  });
  const kept = new Set<number>();
  for (
    let position = tails[tails.length - 1] ?? -1;
    position !== -1;
    position = previous[position]
  ) {
    kept.add(position);
  }
  return kept;
}

/** Stable identity across a topology change: runtime stepId, else the object. */
function stepKey(step: WorkflowStep): unknown {
  return step._runtime?.stepId ?? step;
}

function describeStep(step: WorkflowStep, index: number): string {
  return step.name?.trim()
    ? `Step ${index + 1} ("${step.name.trim()}")`
    : `Step ${index + 1}`;
}
