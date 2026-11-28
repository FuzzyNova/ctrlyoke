import { STEP_TYPES } from "@root/types/DashboardConstants";
import {
  assertNever,
  type InlineSubWorkflowStepKind,
  type WorkflowStepType,
} from "@root/types/CtrlYokeTypes";

/** The editor fields that say which content editor Workflow mode shows. */
export interface EditorContentKindFields {
  stepType: WorkflowStepType;
  /** Workflow mode's inline shell (D13), or null for the File form. */
  subWorkflowInline: { kind: InlineSubWorkflowStepKind } | null;
}

/** The editor draft fields that hold each step kind's content. */
export interface StepDraftContentFields extends EditorContentKindFields {
  promptText: string;
  scriptCommand: string;
  subWorkflowPath: string;
}

/**
 * The kind whose content editor is showing: the step kind itself, except
 * that an inline workflow step (D13) is edited as the prompt or script step
 * it wraps. `WORKFLOW` therefore means the File form.
 */
export function getEditorContentKind(
  draft: EditorContentKindFields
): WorkflowStepType {
  switch (draft.stepType) {
    case STEP_TYPES.PROMPT:
    case STEP_TYPES.SCRIPT:
      return draft.stepType;
    case STEP_TYPES.WORKFLOW:
      return draft.subWorkflowInline?.kind ?? STEP_TYPES.WORKFLOW;
    default:
      return assertNever(draft.stepType);
  }
}

/** Return the content field the editor is showing (see getEditorContentKind). */
export function getStepDraftContent(draft: StepDraftContentFields): string {
  const kind = getEditorContentKind(draft);
  switch (kind) {
    case STEP_TYPES.PROMPT:
      return draft.promptText;
    case STEP_TYPES.SCRIPT:
      return draft.scriptCommand;
    case STEP_TYPES.WORKFLOW:
      return draft.subWorkflowPath;
    default:
      return assertNever(kind);
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
