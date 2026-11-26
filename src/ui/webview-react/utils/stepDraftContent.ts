import { STEP_TYPES } from "@root/types/DashboardConstants";
import { assertNever, type WorkflowStepType } from "@root/types/CtrlYokeTypes";

/** Return the content field selected by the editor's authored step kind. */
export function getStepDraftContent(
  stepType: WorkflowStepType,
  promptText: string,
  scriptCommand: string
): string {
  switch (stepType) {
    case STEP_TYPES.PROMPT:
      return promptText;
    case STEP_TYPES.SCRIPT:
      return scriptCommand;
    default:
      return assertNever(stepType);
  }
}

/** Test script mode while keeping editor step kinds exhaustive. */
export function isScriptEditorStepType(stepType: WorkflowStepType): boolean {
  switch (stepType) {
    case STEP_TYPES.PROMPT:
      return false;
    case STEP_TYPES.SCRIPT:
      return true;
    default:
      return assertNever(stepType);
  }
}
