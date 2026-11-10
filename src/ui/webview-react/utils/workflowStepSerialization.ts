import { STEP_TYPES } from "@root/types/DashboardConstants";
import type { WorkflowStep as PersistedWorkflowStep } from "@root/types/CtrlYokeTypes";
import {
  parseClipboardWorkflowStep,
  serializeWorkflowStepForClipboard,
} from "../../../core/WorkflowStepSanitizer";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";
import type { WorkflowStep } from "@store/workflowStore";
import { readClipboardText } from "./clipboard";

export function isScriptWorkflowStep(step: WorkflowStep): step is ScriptStep {
  return step.type === STEP_TYPES.SCRIPT;
}

export function getWorkflowStepRawText(step: WorkflowStep): string {
  return isScriptWorkflowStep(step) ? step.script : step.prompt;
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
