import {
  isScriptStep,
  type WorkflowStep as PersistedWorkflowStep,
} from "@root/types/CtrlYokeTypes";
import {
  parseClipboardWorkflowStep,
  serializeWorkflowStepForClipboard,
} from "../../../core/WorkflowStepSanitizer";
import type { WorkflowStep } from "@store/workflowStore";
import { readClipboardText } from "./clipboard";

export function getWorkflowStepRawText(step: WorkflowStep): string {
  return isScriptStep(step) ? step.script : step.prompt;
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
