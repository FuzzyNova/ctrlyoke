import { CONDITION_ACTIONS, STEP_TYPES } from "@root/types/DashboardConstants";
import type { SubWorkflowStep } from "@root/types/CtrlYokeTypes";
import { stepEnabledPatch, type StepEnabledValue } from "./wholeValueVariables";

/** The step editor's Workflow-mode values for a file-reference step. */
export interface SubWorkflowStepEditorValues {
  onFail: string;
  color: SubWorkflowStep["color"];
  enabled: StepEnabledValue;
  promptName: string;
}

export interface SubWorkflowStepPropertyUpdate {
  properties: Record<string, unknown>;
  clearProperties: string[];
}

/**
 * Build the file-reference sub-workflow step's property update, shared by
 * the editor's save/dispatch paths and the execution preview. The `workflow`
 * path itself travels as the message's `text`, like a script's command.
 *
 * A same-kind save merges over the step on disk, so a field reset to its
 * default is named in `clearProperties` rather than omitted.
 */
export function getSubWorkflowStepPropertyUpdate(
  editor: SubWorkflowStepEditorValues
): SubWorkflowStepPropertyUpdate {
  const properties: Record<string, unknown> = {
    type: STEP_TYPES.WORKFLOW,
    ...(editor.onFail !== CONDITION_ACTIONS.STOP_WORKFLOW
      ? { onFail: editor.onFail as SubWorkflowStep["onFail"] }
      : {}),
    ...(editor.color !== undefined ? { color: editor.color } : {}),
    ...stepEnabledPatch(editor.enabled),
  };

  const clearProperties = [
    ...(editor.onFail === CONDITION_ACTIONS.STOP_WORKFLOW ? ["onFail"] : []),
    ...(editor.color === undefined ? ["color"] : []),
    ...(editor.enabled === true ? ["enabled"] : []),
    ...(!editor.promptName.trim() ? ["name"] : []),
  ];

  return { properties, clearProperties };
}
