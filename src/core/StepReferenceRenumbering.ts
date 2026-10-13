import { isScriptStep, type WorkflowStep } from "../types/CtrlYokeTypes";
import { hasStarted } from "../utils/StepStatusDerivation";
import { formatInlinePriorContextBody, scanInlinePriorContextRefs } from "../utils/FileReferenceParser";
import { PRIOR_CONTEXT_REFERENCE_KINDS } from "../types/DashboardConstants";

export interface StepReferenceRenumberingResult {
  steps: WorkflowStep[];
  finalStep?: WorkflowStep;
  refusals: string[];
}

/**
 * Rewrites structured positional references after a queue topology change.
 * Existing steps are matched by their stable runtime stepId; newly inserted
 * steps keep the numbers authored for their position in the new queue.
 */
export function renumberStepReferences(
  oldSteps: readonly WorkflowStep[],
  newSteps: readonly WorkflowStep[],
  finalStep?: WorkflowStep
): StepReferenceRenumberingResult {
  const oldIndexById = buildStepIndex(oldSteps);
  const newIndexById = buildStepIndex(newSteps);
  const refusals: string[] = [];

  const renumberStep = (
    step: WorkflowStep,
    isFinalStep = false
  ): WorkflowStep => {
    if (isScriptStep(step)) return step;
    const stepId = step._runtime?.stepId;
    const oldIndex = findStepIndex(step, stepId, oldIndexById);
    if (oldIndex === undefined && !isFinalStep) return step;

    let sessionId = step.sessionId;
    if (typeof sessionId === "number") {
      const target = oldSteps[sessionId - 1];
      const targetId = target?._runtime?.stepId;
      const targetNewIndex = target
        ? findStepIndex(target, targetId, newIndexById)
        : undefined;
      if (target && targetNewIndex === undefined) {
        if (isFinalStep || !hasStarted(step)) {
          refusals.push(
            isFinalStep
              ? "Final step"
              : describeReferencingStep(step, oldIndex!)
          );
        } else {
          sessionId = undefined;
        }
      } else if (targetNewIndex !== undefined) {
        sessionId = targetNewIndex + 1;
      }
    }

    let priorContext = step.priorContext;
    if (Array.isArray(priorContext)) {
      priorContext = priorContext.flatMap((reference) => {
        const target = oldSteps[reference - 1];
        const targetId = target?._runtime?.stepId;
        const targetNewIndex = target
          ? findStepIndex(target, targetId, newIndexById)
          : undefined;
        if (target && targetNewIndex === undefined) {
          if (isFinalStep || !hasStarted(step)) {
            refusals.push(
              isFinalStep
                ? "Final step"
                : describeReferencingStep(step, oldIndex!)
            );
            return [reference];
          }
          return [];
        }
        return targetNewIndex === undefined
          ? [reference]
          : [targetNewIndex + 1];
      });
    }

    const renumberInlineReferences = (text: string | undefined): string | undefined => {
      if (typeof text !== "string") return text;
      let rewritten = text;
      const matches = scanInlinePriorContextRefs(text).filter(
        (match) => match.ref.kind === PRIOR_CONTEXT_REFERENCE_KINDS.STEP
      );
      for (const match of [...matches].reverse()) {
        if (match.ref.kind !== PRIOR_CONTEXT_REFERENCE_KINDS.STEP) continue;
        const indices = match.ref.indices.flatMap((reference) => {
          const target = oldSteps[reference - 1];
          const targetId = target?._runtime?.stepId;
          const targetNewIndex = target
            ? findStepIndex(target, targetId, newIndexById)
            : undefined;
          if (target && targetNewIndex === undefined) {
            if (isFinalStep || !hasStarted(step)) {
              refusals.push(
                isFinalStep
                  ? "Final step"
                  : describeReferencingStep(step, oldIndex!)
              );
              return [reference];
            }
            return [];
          }
          return [targetNewIndex === undefined ? reference : targetNewIndex + 1];
        });
        const body = formatInlinePriorContextBody({ ...match.ref, indices });
        rewritten = `${rewritten.slice(0, match.startOffset)}$${body}${rewritten.slice(match.endOffset)}`;
      }
      return rewritten;
    };
    const prompt = renumberInlineReferences(step.prompt);
    const endCondition = step.endCondition && {
      ...step.endCondition,
      ...(step.endCondition.retryPrompt !== undefined
        ? { retryPrompt: renumberInlineReferences(step.endCondition.retryPrompt) }
        : {}),
      ...(step.endCondition.passRetryPrompt !== undefined
        ? { passRetryPrompt: renumberInlineReferences(step.endCondition.passRetryPrompt) }
        : {}),
    };

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
    refusals: [...new Set(refusals)],
  };
}

/**
 * Throws when removing `removedIndices` would orphan a reference from an
 * unstarted step or the final step (see `renumberStepReferences` refusals).
 */
export function assertStepRemovalUnreferenced(
  result: StepReferenceRenumberingResult,
  removedIndices: readonly number[]
): void {
  if (result.refusals.length === 0) return;
  const label = removedIndices.length === 1 ? "step" : "steps";
  const positions = removedIndices.map((index) => index + 1).join(", ");
  throw new Error(
    `Cannot remove ${label} ${positions}: referenced by ${result.refusals.join(", ")}`
  );
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
