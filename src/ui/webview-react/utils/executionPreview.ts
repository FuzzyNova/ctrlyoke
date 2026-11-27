import { useEditorStore } from "@store/editorStore";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import {
  useWorkflowStore,
  type WorkflowStep as WebviewWorkflowStep,
} from "@store/workflowStore";
import {
  EDITOR_TARGET_KINDS,
  FINAL_STEP_PHASES,
  PREVIEW_SCOPES,
  STEP_TYPES,
} from "@root/types/DashboardConstants";
import type {
  PromptStep,
  ScriptStep,
  SubWorkflowStep,
} from "@root/types/CtrlYokeTypes";
import {
  assertNever,
  isPromptStep,
  isScriptStep,
  isSubWorkflowStep,
} from "@root/types/CtrlYokeTypes";
import type { ExecutionPreviewEditorSnapshot } from "@root/types/WebviewMessageTypes";
import { getScriptStepPropertyUpdate } from "@utils/scriptStepProperties";
import { getSubWorkflowStepPropertyUpdate } from "@utils/subWorkflowStepProperties";

/**
 * Overlay a script or sub-workflow step's property update on its saved step,
 * the way the save merges it: set properties win, cleared ones are removed.
 */
function overlayStepUpdate<T extends ScriptStep | SubWorkflowStep>(
  base: T,
  update: { properties: Record<string, unknown>; clearProperties: string[] },
  content: Partial<T>,
  promptName: string
): T {
  const step: T = {
    ...base,
    ...update.properties,
    ...content,
    ...(promptName.trim() ? { name: promptName.trim() } : {}),
  };
  for (const property of update.clearProperties) {
    delete step[property as keyof T];
  }
  return step;
}

/**
 * Open a whole-workflow Dry Run. The extension previews this client's
 * displayed workflow, so callers must only offer it for that workflow.
 */
export function openWorkflowDryRun(): void {
  useExecutionPreviewStore
    .getState()
    .open(
      { kind: PREVIEW_SCOPES.WORKFLOW },
      getExecutionPreviewEditorSnapshot()
    );
}

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

  switch (editor.stepType) {
    case STEP_TYPES.SCRIPT: {
      const base: ScriptStep =
        existingStep && isScriptStep(existingStep)
          ? existingStep
          : { type: STEP_TYPES.SCRIPT, script: "" };
      const { properties, clearProperties } = getScriptStepPropertyUpdate({
        env: editor.scriptEnv,
        secrets: editor.properties.secrets,
        errorBehavior: editor.properties.errorBehavior,
        timeoutSec: editor.scriptTimeoutSec,
        onPass: editor.scriptOnPass,
        onFail: editor.scriptOnFail,
        compareSource: editor.scriptCompareSource,
        operator: editor.scriptOperator,
        expected: editor.scriptExpected,
        ignoreCase: editor.scriptIgnoreCase,
        executionMode: editor.scriptExecutionMode,
        shell: editor.scriptShell,
        color: editor.properties.color,
        enabled: editor.stepEnabled,
        promptName: editor.promptName,
      });
      const step = overlayStepUpdate(
        base,
        { properties, clearProperties },
        { script: editor.scriptCommand },
        editor.promptName
      );
      return {
        step,
        ...(isFinalStep ? { isFinalStep: true } : { stepIndex }),
      };
    }
    case STEP_TYPES.PROMPT:
      break;
    case STEP_TYPES.WORKFLOW: {
      // Only a file reference reaches here: an inline definition has no
      // editor content, so `hasContent()` above returned for it.
      const base: SubWorkflowStep =
        existingStep && isSubWorkflowStep(existingStep)
          ? existingStep
          : { type: STEP_TYPES.WORKFLOW, workflow: "" };
      const step = overlayStepUpdate(
        base,
        getSubWorkflowStepPropertyUpdate({
          onFail: editor.subWorkflowOnFail,
          color: editor.properties.color,
          enabled: editor.stepEnabled,
          promptName: editor.promptName,
        }),
        { workflow: editor.subWorkflowPath },
        editor.promptName
      );
      return {
        step,
        ...(isFinalStep ? { isFinalStep: true } : { stepIndex }),
      };
    }
    default:
      assertNever(editor.stepType);
  }

  const base: PromptStep =
    existingStep && isPromptStep(existingStep)
      ? (existingStep as PromptStep)
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
  if (editor.stepEnabled === true) delete step.enabled;
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
