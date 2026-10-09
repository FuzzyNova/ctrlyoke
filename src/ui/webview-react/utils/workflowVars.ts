import { useSettingsStore } from "../store/settingsStore";
import { useWorkflowStore } from "../store/workflowStore";
import { MESSAGE_TYPES } from "../types/messages";
import { PROMPT_PROPERTIES } from "@root/types/DashboardConstants";
import { isVariableDefined } from "@root/utils/VariablePlaceholders";
import { postWorkflowDefinitionMutation } from "./workflowMutation";

interface MessageTarget {
  postMessage: (message: unknown) => void;
}

/**
 * Replace the workflow's `vars` defaults: optimistic store update, undo
 * snapshot, then the persisted mutation. An empty map removes the root
 * property instead of persisting `vars: {}` — the extension's
 * workflow-property path treats an undefined value as an explicit delete.
 */
export function commitWorkflowVars(
  target: MessageTarget,
  vars: Record<string, string>
): void {
  const nextVars = Object.keys(vars).length > 0 ? vars : undefined;
  const settingsStore = useSettingsStore.getState();
  settingsStore.updateWorkflowProperty(PROMPT_PROPERTIES.VARS, nextVars);
  useWorkflowStore
    .getState()
    .setUndoWorkflowProperties(useSettingsStore.getState().workflowProperties);

  postWorkflowDefinitionMutation(target, {
    type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
    property: PROMPT_PROPERTIES.VARS,
    value: nextVars,
  });
}

/**
 * Add `name` to the workflow's vars with an empty value, leaving an existing
 * entry untouched. Backs the prompt editor's "add to workflow vars" quick fix;
 * the caller then reveals the row so the author can type the value.
 */
export function defineWorkflowVariable(
  target: MessageTarget,
  name: string
): void {
  const vars = useSettingsStore.getState().workflowProperties.vars ?? {};
  if (isVariableDefined(vars, name)) return;
  commitWorkflowVars(target, { ...vars, [name]: "" });
}
