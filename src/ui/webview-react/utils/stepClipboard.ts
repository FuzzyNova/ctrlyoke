import { STEP_TYPES } from "@root/types/DashboardConstants";
import type { WorkflowStep as PersistedWorkflowStep } from "@root/types/FlightPathTypes";
import {
  parseClipboardWorkflowStep,
  serializeWorkflowStepForClipboard,
} from "../../../flightpath/WorkflowStepSanitizer";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";
import type { WorkflowStep } from "@store/workflowStore";

export interface WorkflowStepUpdateRequest {
  text: string;
  promptName: string;
  properties: Record<string, unknown>;
  clearProperties?: string[];
}

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

export async function readClipboardText(): Promise<string> {
  if (navigator.clipboard?.readText) {
    return navigator.clipboard.readText();
  }

  throw new Error("Clipboard read is unavailable in this webview");
}

export async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}

export async function readWorkflowStepFromClipboard(): Promise<WorkflowStep> {
  return parseWorkflowStepClipboardText(await readClipboardText());
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
        ...(step.timeout !== undefined && { timeout: step.timeout }),
        ...(step.compareSource !== undefined && {
          compareSource: step.compareSource,
        }),
        ...(step.returns !== undefined && { returns: step.returns }),
        ...(step.onPass !== undefined && { onPass: step.onPass }),
        ...(step.onFail !== undefined && { onFail: step.onFail }),
        ...(!enabled && { enabled: false }),
      },
      ...(enabled ? { clearProperties: ["enabled"] } : {}),
    };
  }

  return {
    text: step.prompt,
    promptName: step.name ?? "",
    properties: {
      ...(!enabled && { enabled: false }),
    },
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

  return {
    ...sanitizedStep,
    enabled: false,
  };
}

export function isEditableClipboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    Boolean(target.closest("[contenteditable='true'], [contenteditable='']"))
  );
}
