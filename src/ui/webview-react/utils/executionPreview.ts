import { useEditorStore } from "@store/editorStore";
import {
  useWorkflowStore,
  type WorkflowStep as WebviewWorkflowStep,
} from "@store/workflowStore";
import {
  CONDITION_ACTIONS,
  DEFAULT_COMPARE_SOURCE,
  DEFAULT_SCRIPT_OPERATOR,
  EDITOR_TARGET_KINDS,
  FINAL_STEP_PHASES,
  STEP_TYPES,
} from "@root/types/DashboardConstants";
import type { PromptStep, ScriptStep } from "@root/types/CtrlYokeTypes";
import type { ExecutionPreviewEditorSnapshot } from "@root/types/WebviewMessageTypes";

/**
 * Capture the editor's current step without changing editor or workflow state.
 * The extension overlays this one-shot snapshot on the working definition for
 * the preview request, so drawer edits are visible before Update is pressed.
 */
export function getExecutionPreviewEditorSnapshot():
  ExecutionPreviewEditorSnapshot | undefined {
  const editor = useEditorStore.getState();
  const workflow = useWorkflowStore.getState();
  const { selectionTarget } = editor;

  const isFinalStep = selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP;
  const stepIndex =
    selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
      ? selectionTarget.index
      : selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT
        ? workflow.steps.length
        : undefined;

  if (!isFinalStep && stepIndex === undefined) return undefined;
  if (!editor.hasContent()) return undefined;

  const existingStep: WebviewWorkflowStep | undefined = isFinalStep
    ? (workflow.finalStep ?? undefined)
    : stepIndex !== undefined
      ? workflow.steps[stepIndex]
      : undefined;

  if (editor.stepType === STEP_TYPES.SCRIPT) {
    const base: ScriptStep =
      existingStep?.type === STEP_TYPES.SCRIPT
        ? existingStep
        : { type: STEP_TYPES.SCRIPT, script: "" };
    const step: ScriptStep = {
      ...base,
      type: STEP_TYPES.SCRIPT,
      script: editor.scriptCommand,
      ...(editor.promptName.trim() ? { name: editor.promptName.trim() } : {}),
      ...(editor.scriptTimeoutSec !== undefined
        ? { timeoutSec: editor.scriptTimeoutSec }
        : {}),
      ...(editor.scriptOnPass !== CONDITION_ACTIONS.CONTINUE
        ? { onPass: editor.scriptOnPass as ScriptStep["onPass"] }
        : {}),
      ...(editor.scriptOnFail !== CONDITION_ACTIONS.STOP_WORKFLOW
        ? { onFail: editor.scriptOnFail as ScriptStep["onFail"] }
        : {}),
      ...(editor.scriptCompareSource !== DEFAULT_COMPARE_SOURCE
        ? {
            compareSource:
              editor.scriptCompareSource as ScriptStep["compareSource"],
          }
        : {}),
      ...(editor.scriptOperator !== DEFAULT_SCRIPT_OPERATOR
        ? { operator: editor.scriptOperator as ScriptStep["operator"] }
        : {}),
      ...(editor.scriptExpected.trim()
        ? { expected: editor.scriptExpected }
        : {}),
      ...(editor.scriptIgnoreCase ? { ignoreCase: true } : {}),
      ...(editor.stepEnabled ? {} : { enabled: false }),
    };
    if (!editor.promptName.trim()) delete step.name;
    if (editor.stepEnabled) delete step.enabled;
    if (editor.properties.executionMode === undefined) {
      delete step.executionMode;
    } else {
      step.executionMode = editor.properties.executionMode;
    }
    if (editor.properties.errorBehavior === undefined) {
      delete step.errorBehavior;
    } else {
      step.errorBehavior = editor.properties.errorBehavior;
    }
    return {
      step,
      ...(isFinalStep ? { isFinalStep: true } : { stepIndex }),
    };
  }

  const base: PromptStep =
    existingStep?.type !== STEP_TYPES.SCRIPT
      ? ((existingStep as PromptStep | undefined) ?? { prompt: "" })
      : { prompt: "" };
  const step: PromptStep = {
    ...base,
    ...(editor.getPromptProperties() as Partial<PromptStep>),
    prompt: editor.promptText,
  };
  if (editor.promptName.trim()) {
    step.name = editor.promptName.trim();
  } else {
    delete step.name;
  }
  if (editor.stepEnabled) delete step.enabled;
  if (
    editor.properties.sessionId === undefined ||
    !editor.properties.sessionId
  ) {
    delete step.sessionId;
  } else {
    step.sessionId = editor.properties.sessionId;
  }

  // `getPromptProperties` intentionally omits undefined values. Delete those
  // inherited overrides from the base step so switching a field back to
  // Default is represented correctly in the preview snapshot.
  if (editor.properties.harness === undefined) delete step.harness;
  if (editor.properties.model === undefined) delete step.model;
  if (editor.properties.executionMode === undefined) delete step.executionMode;
  if (editor.properties.agent === undefined) delete step.agent;
  if (editor.properties.skills === undefined) delete step.skills;
  if (editor.properties.resumeSession === undefined) delete step.resumeSession;
  if (editor.properties.mcpServers === undefined) delete step.mcpServers;
  if (editor.properties.hooks === undefined) delete step.hooks;
  if (editor.properties.endCondition === undefined) delete step.endCondition;
  if (editor.properties.errorBehavior === undefined) delete step.errorBehavior;
  if (editor.properties.preCondition === undefined) delete step.preCondition;
  if (editor.properties.priorContext === undefined) delete step.priorContext;
  if (editor.properties.priorContextDetail === undefined)
    delete step.priorContextDetail;
  if (editor.properties.additionalArgs === undefined) {
    delete step.additionalArgs;
  }
  if (editor.properties.toolPermissions === undefined) {
    delete step.toolPermissions;
  }
  if (editor.properties.endCondition !== undefined) {
    step.endCondition = editor.properties
      .endCondition as PromptStep["endCondition"];
  }

  return {
    step,
    ...(isFinalStep ? { isFinalStep: true } : { stepIndex }),
  };
}
