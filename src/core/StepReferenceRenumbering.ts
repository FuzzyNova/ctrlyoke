import { isScriptStep, type WorkflowStep } from "../types/CtrlYokeTypes";
import { hasStarted } from "../utils/StepStatusDerivation";
import {
  formatInlinePriorContextBody,
  parseInlinePriorContextRefs,
} from "../utils/FileReferenceParser";
import { PRIOR_CONTEXT_REFERENCE_KINDS } from "../types/DashboardConstants";

export interface StepReferenceRenumberingResult {
  steps: WorkflowStep[];
  finalStep?: WorkflowStep;
  /**
   * Labels of unstarted steps (and the final step) whose positional
   * references a removal invalidated or left pointing at a different step.
   * Removal is never refused for them; callers warn instead.
   */
  affectedSteps: string[];
}

/** A removed target, as opposed to `undefined` for a position with no old step. */
const REMOVED_TARGET = null;

/**
 * Rewrites positional references after a queue topology change. Existing
 * steps are matched by their stable runtime stepId; newly inserted steps keep
 * the numbers authored for their position in the new queue.
 *
 * Structured fields (`sessionId`, `priorContext` arrays) always follow their
 * targets, and a removed target is dropped from them. Inline `$step:N` text is
 * renumbered on insert and reorder, but a removal never edits prompt text: the
 * author's references stay exactly as written, the editor flags any that no
 * longer resolve, and the step is reported in `affectedSteps`.
 */
export function renumberStepReferences(
  oldSteps: readonly WorkflowStep[],
  newSteps: readonly WorkflowStep[],
  finalStep?: WorkflowStep
): StepReferenceRenumberingResult {
  const oldIndexById = buildStepIndex(oldSteps);
  const newIndexById = buildStepIndex(newSteps);
  const affectedSteps: string[] = [];
  const removesSteps = oldSteps.some(
    (step) =>
      findStepIndex(step, step._runtime?.stepId, newIndexById) === undefined
  );

  /** New 1-based position of an old reference, or `REMOVED_TARGET`. */
  const newPositionOf = (reference: number): number | null | undefined => {
    const target = oldSteps[reference - 1];
    if (!target) return undefined;
    const targetNewIndex = findStepIndex(
      target,
      target._runtime?.stepId,
      newIndexById
    );
    return targetNewIndex === undefined ? REMOVED_TARGET : targetNewIndex + 1;
  };

  const renumberStep = (
    step: WorkflowStep,
    isFinalStep = false
  ): WorkflowStep => {
    if (isScriptStep(step)) return step;
    const stepId = step._runtime?.stepId;
    const oldIndex = findStepIndex(step, stepId, oldIndexById);
    if (oldIndex === undefined && !isFinalStep) return step;
    // A started step has already resolved its references, so only steps that
    // will still resolve them are worth warning about.
    const warnable = isFinalStep || !hasStarted(step);
    let affected = false;

    let sessionId = step.sessionId;
    if (typeof sessionId === "number") {
      const position = newPositionOf(sessionId);
      if (position === REMOVED_TARGET) {
        sessionId = undefined;
        affected ||= warnable;
      } else if (position !== undefined) {
        sessionId = position;
      }
    }

    let priorContext = step.priorContext;
    if (Array.isArray(priorContext)) {
      priorContext = priorContext.flatMap((reference) => {
        const position = newPositionOf(reference);
        if (position === REMOVED_TARGET) {
          affected ||= warnable;
          return [];
        }
        return [position ?? reference];
      });
    }

    const renumberInlineReferences = (
      text: string | undefined
    ): string | undefined => {
      if (typeof text !== "string") return text;
      let rewritten = text;
      // Code spans are masked offset-preserving, so references written
      // literally inside them are never rewritten.
      const matches = parseInlinePriorContextRefs(text).filter(
        (match) => match.ref.kind === PRIOR_CONTEXT_REFERENCE_KINDS.STEP
      );
      for (const match of [...matches].reverse()) {
        if (match.ref.kind !== PRIOR_CONTEXT_REFERENCE_KINDS.STEP) continue;
        const original = match.ref.indices;
        const positions = original.map(newPositionOf);
        const unchanged = positions.every(
          (position, at) => position === undefined || position === original[at]
        );
        if (removesSteps) {
          affected ||= warnable && !unchanged;
          continue;
        }
        // Leave an unaffected token exactly as written (e.g. keep `1-3`).
        if (unchanged) continue;
        // Without a removal every old target still has a position.
        const indices = positions.map(
          (position, at) => position ?? original[at]
        );
        const body = formatInlinePriorContextBody({ ...match.ref, indices });
        rewritten = `${rewritten.slice(0, match.startOffset)}$${body}${rewritten.slice(match.endOffset)}`;
      }
      return rewritten;
    };
    const prompt = renumberInlineReferences(step.prompt);
    const endCondition = step.endCondition && {
      ...step.endCondition,
      ...(step.endCondition.retryPrompt !== undefined
        ? {
            retryPrompt: renumberInlineReferences(
              step.endCondition.retryPrompt
            ),
          }
        : {}),
      ...(step.endCondition.passRetryPrompt !== undefined
        ? {
            passRetryPrompt: renumberInlineReferences(
              step.endCondition.passRetryPrompt
            ),
          }
        : {}),
    };
    if (affected) {
      affectedSteps.push(
        isFinalStep ? "Final step" : describeReferencingStep(step, oldIndex!)
      );
    }

    const { sessionId: _oldSessionId, ...stepWithoutSessionId } = step;
    return {
      ...stepWithoutSessionId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(priorContext !== undefined ? { priorContext } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(endCondition !== undefined ? { endCondition } : {}),
    } as WorkflowStep;
  };

  const steps = newSteps.map((step) => renumberStep(step));
  const renumberedFinalStep = finalStep
    ? renumberStep(finalStep, true)
    : undefined;

  return {
    steps,
    ...(renumberedFinalStep ? { finalStep: renumberedFinalStep } : {}),
    affectedSteps,
  };
}

/**
 * The warning shown after removing `removedIndices`, or `undefined` when no
 * remaining step's references were affected. Removal itself always proceeds.
 */
export function describeStepRemovalWarning(
  result: StepReferenceRenumberingResult,
  removedIndices: readonly number[]
): string | undefined {
  if (result.affectedSteps.length === 0) return undefined;
  const label = removedIndices.length === 1 ? "step" : "steps";
  const positions = [...removedIndices]
    .sort((left, right) => left - right)
    .map((index) => index + 1)
    .join(", ");
  return `Removed ${label} ${positions}. Step references in ${result.affectedSteps.join(", ")} may now point at a missing or different step; check them.`;
}

interface StepIndex {
  byId: Map<string, number>;
  byObject: WeakMap<WorkflowStep, number>;
}

function buildStepIndex(steps: readonly WorkflowStep[]): StepIndex {
  const byId = new Map<string, number>();
  const byObject = new WeakMap<WorkflowStep, number>();
  steps.forEach((step, index) => {
    const stepId = step._runtime?.stepId;
    if (stepId) {
      byId.set(stepId, index);
    }
    byObject.set(step, index);
  });
  return { byId, byObject };
}

function findStepIndex(
  step: WorkflowStep,
  stepId: string | undefined,
  index: StepIndex
): number | undefined {
  return stepId ? index.byId.get(stepId) : index.byObject.get(step);
}

function describeReferencingStep(step: WorkflowStep, index: number): string {
  return step.name?.trim()
    ? `Step ${index + 1} ("${step.name.trim()}")`
    : `Step ${index + 1}`;
}
