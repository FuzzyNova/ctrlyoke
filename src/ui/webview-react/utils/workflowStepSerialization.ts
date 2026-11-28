import {
  assertNever,
  getStepType,
  isSubWorkflowStep,
  getWorkflowStepText,
  type PromptStep,
  type ScriptStep,
  type WorkflowStep as PersistedWorkflowStep,
} from "@root/types/CtrlYokeTypes";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import {
  parseClipboardWorkflowStep,
  serializeWorkflowStepForClipboard,
} from "../../../core/WorkflowStepSanitizer";
import type { WorkflowStep } from "@store/workflowStore";
import { readClipboardText } from "./clipboard";

export function getWorkflowStepRawText(step: WorkflowStep): string {
  const stepType = getStepType(step);
  switch (stepType) {
    case STEP_TYPES.PROMPT:
      return (step as PromptStep).prompt;
    case STEP_TYPES.SCRIPT:
      return (step as ScriptStep).script;
    case STEP_TYPES.WORKFLOW:
      return isSubWorkflowStep(step) ? getWorkflowStepText(step) : "";
    default:
      return assertNever(stepType);
  }
}

export function serializeWorkflowStepText(step: WorkflowStep): string {
  return serializeWorkflowStepForClipboard(step as PersistedWorkflowStep);
}

export function parseWorkflowStepClipboardText(text: string): WorkflowStep {
  return parseClipboardWorkflowStep(text) as WorkflowStep;
}

export async function readWorkflowStepFromClipboard(): Promise<WorkflowStep> {
  return parseWorkflowStepClipboardText(await readClipboardText());
}
