import { STEP_TYPES } from "@root/types/DashboardConstants";
import { assertNever, type WorkflowStepType } from "@root/types/CtrlYokeTypes";

/** The editor draft fields that hold each step kind's content. */
export interface StepDraftContentFields {
  stepType: WorkflowStepType;
  promptText: string;
  scriptCommand: string;
  subWorkflowPath: string;
}

/** Return the content field selected by the editor's authored step kind. */
export function getStepDraftContent(draft: StepDraftContentFields): string {
  switch (draft.stepType) {
    case STEP_TYPES.PROMPT:
      return draft.promptText;
    case STEP_TYPES.SCRIPT:
      return draft.scriptCommand;
    case STEP_TYPES.WORKFLOW:
      return draft.subWorkflowPath;
    default:
      return assertNever(draft.stepType);
  }
}

/**
 * The kind of a new-step draft whose content only the editor can keep:
 * Recent Prompts stores prompt text alone, so a non-empty script or workflow
 * draft that something replaces is lost. `undefined` for a prompt draft and
 * an empty one. The one check behind Move to Editor's guard and the store
 * keeping such a draft.
 */
export function getEditorOnlyDraftKind(
  draft: StepDraftContentFields
): WorkflowStepType | undefined {
  if (isPromptEditorStepType(draft.stepType)) return undefined;
  return getStepDraftContent(draft).trim().length > 0
    ? draft.stepType
    : undefined;
}

/** Test script mode while keeping editor step kinds exhaustive. */
export function isScriptEditorStepType(stepType: WorkflowStepType): boolean {
  switch (stepType) {
    case STEP_TYPES.PROMPT:
      return false;
    case STEP_TYPES.SCRIPT:
      return true;
    case STEP_TYPES.WORKFLOW:
      return false;
    default:
      return assertNever(stepType);
  }
}

/** Test Workflow (sub-workflow step) mode while keeping step kinds exhaustive. */
export function isSubWorkflowEditorStepType(
  stepType: WorkflowStepType
): boolean {
  switch (stepType) {
    case STEP_TYPES.PROMPT:
      return false;
    case STEP_TYPES.SCRIPT:
      return false;
    case STEP_TYPES.WORKFLOW:
      return true;
    default:
      return assertNever(stepType);
  }
}

/**
 * Test prompt mode: the only kind with the prompt editor, its properties
 * drawer and the footer's quick pickers.
 */
export function isPromptEditorStepType(stepType: WorkflowStepType): boolean {
  switch (stepType) {
    case STEP_TYPES.PROMPT:
      return true;
    case STEP_TYPES.SCRIPT:
      return false;
    case STEP_TYPES.WORKFLOW:
      return false;
    default:
      return assertNever(stepType);
  }
}
