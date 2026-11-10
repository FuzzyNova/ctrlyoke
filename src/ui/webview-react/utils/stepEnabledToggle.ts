import { STEP_TYPES } from "@root/types/DashboardConstants";
import type { WorkflowStep } from "@store/workflowStore";
import {
  isScriptWorkflowStep,
  parseWorkflowStepClipboardText,
  serializeWorkflowStepText,
} from "./workflowStepSerialization";

export interface WorkflowStepUpdateRequest {
  text: string;
  promptName: string;
  properties: Record<string, unknown>;
  clearProperties?: string[];
}

export function buildWorkflowStepEnabledUpdate(
  step: WorkflowStep,
  enabled: boolean
): WorkflowStepUpdateRequest {
  if (isScriptWorkflowStep(step)) {
    return {
      text: step.script,
      promptName: step.name ?? "",
      properties: {
        type: STEP_TYPES.SCRIPT,
        ...(!enabled && { enabled: false }),
      },
      ...(enabled ? { clearProperties: ["enabled"] } : {}),
    };
  }

  return {
    text: step.prompt,
    promptName: step.name ?? "",
    properties: { ...(!enabled && { enabled: false }) },
    ...(enabled ? { clearProperties: ["enabled"] } : {}),
  };
}

export function buildWorkflowStepEnabledState(
  step: WorkflowStep,
  enabled: boolean
): WorkflowStep {
  const sanitizedStep = parseWorkflowStepClipboardText(
    serializeWorkflowStepText(step)
  );
  if (enabled) {
    const { enabled: _enabled, ...rest } = sanitizedStep;
    void _enabled;
    return rest as WorkflowStep;
  }
  return { ...sanitizedStep, enabled: false };
}
