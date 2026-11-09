import { isDeepStrictEqual } from "util";
import type { WorkflowStep } from "../types/CtrlYokeTypes";
import { hasStarted } from "../utils/StepStatusDerivation";
import {
  stripStepRuntime,
  stripViewOnlyWorkflowStepFields,
} from "./WorkflowStepSanitizer";

/** Refuse undo/redo snapshots that alter the identity or definition of executed steps. */
export function assertUndoRedoPreservesExecutedSteps(
  currentSteps: readonly WorkflowStep[],
  incomingSteps: readonly WorkflowStep[],
  editableAfterRewind: ReadonlySet<number> = new Set()
): void {
  currentSteps.forEach((step, index) => {
    if (
      editableAfterRewind.has(index) ||
      (!hasStarted(step) && step._runtime?.terminalStatus === undefined)
    ) {
      return;
    }
    const incoming = incomingSteps[index];
    const currentStepId = step._runtime?.stepId;
    const incomingStepId = incoming?._runtime?.stepId;
    const currentDefinition = stripStepRuntime([
      stripViewOnlyWorkflowStepFields(step),
    ])[0];
    const incomingDefinition =
      incoming &&
      stripStepRuntime([stripViewOnlyWorkflowStepFields(incoming)])[0];
    if (
      !incomingDefinition ||
      (currentStepId !== undefined &&
        incomingStepId !== undefined &&
        currentStepId !== incomingStepId) ||
      !isDeepStrictEqual(currentDefinition, incomingDefinition)
    ) {
      throw new Error("Cannot undo or redo a change to a step that has already run");
    }
  });
}
