import { STEP_TYPES } from "@root/types/DashboardConstants";
import {
  assertNever,
  getStepType,
  isSubWorkflowStep,
  getWorkflowStepText,
  type ScriptStep,
  type PromptStep,
} from "@root/types/CtrlYokeTypes";
import type { WorkflowStep } from "@store/workflowStore";
import {
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
  const stepType = getStepType(step);
  switch (stepType) {
    case STEP_TYPES.SCRIPT: {
      const scriptStep = step as ScriptStep;
      return {
        text: scriptStep.script,
        promptName: scriptStep.name ?? "",
        properties: {
          type: STEP_TYPES.SCRIPT,
          ...(!enabled && { enabled: false }),
        },
        ...(enabled ? { clearProperties: ["enabled"] } : {}),
      };
    }
    case STEP_TYPES.PROMPT: {
      const promptStep = step as PromptStep;
      return {
        text: promptStep.prompt,
        promptName: promptStep.name ?? "",
        properties: { ...(!enabled && { enabled: false }) },
        ...(enabled ? { clearProperties: ["enabled"] } : {}),
      };
    }
    case STEP_TYPES.WORKFLOW:
      if (!isSubWorkflowStep(step)) {
        throw new Error("Invalid workflow step kind");
      }
      return {
        text: getWorkflowStepText(step),
        promptName: step.name ?? "",
        properties: {
          type: STEP_TYPES.WORKFLOW,
          workflow: step.workflow,
          ...(!enabled && { enabled: false }),
        },
        ...(enabled ? { clearProperties: ["enabled"] } : {}),
      };
    default:
      return assertNever(stepType);
  }
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
