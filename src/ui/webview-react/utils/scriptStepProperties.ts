import {
  CONDITION_ACTIONS,
  DEFAULT_COMPARE_SOURCE,
  DEFAULT_SCRIPT_OPERATOR,
  STEP_TYPES,
} from "@root/types/DashboardConstants";
import type { ScriptStep } from "@root/types/CtrlYokeTypes";
import { stepEnabledPatch, type StepEnabledValue } from "./wholeValueVariables";

export interface ScriptStepEditorValues {
  env: Record<string, string> | undefined;
  secrets: ScriptStep["secrets"] | undefined;
  errorBehavior: ScriptStep["errorBehavior"];
  timeoutSec: ScriptStep["timeoutSec"];
  onPass: string;
  onFail: string;
  compareSource: string;
  operator: string;
  expected: string;
  ignoreCase: boolean;
  executionMode: ScriptStep["executionMode"];
  shell: ScriptStep["shell"];
  color: ScriptStep["color"];
  enabled: StepEnabledValue;
  promptName: string;
}

export interface ScriptStepPropertyUpdate {
  properties: Record<string, unknown>;
  clearProperties: string[];
}

/** Build the script-step property update used by both save and preview paths. */
export function getScriptStepPropertyUpdate(
  editor: ScriptStepEditorValues
): ScriptStepPropertyUpdate {
  const properties: Record<string, unknown> = {
    type: STEP_TYPES.SCRIPT,
    ...(editor.env && Object.keys(editor.env).length > 0
      ? { env: editor.env }
      : {}),
    ...(editor.secrets === null
      ? { secrets: null }
      : Array.isArray(editor.secrets) && editor.secrets.length > 0
        ? { secrets: editor.secrets }
        : {}),
    ...(editor.errorBehavior !== undefined
      ? { errorBehavior: editor.errorBehavior }
      : {}),
    ...(editor.timeoutSec !== undefined
      ? { timeoutSec: editor.timeoutSec }
      : {}),
    ...(editor.onPass !== CONDITION_ACTIONS.CONTINUE
      ? { onPass: editor.onPass as ScriptStep["onPass"] }
      : {}),
    ...(editor.onFail !== CONDITION_ACTIONS.STOP_WORKFLOW
      ? { onFail: editor.onFail as ScriptStep["onFail"] }
      : {}),
    ...(editor.compareSource !== DEFAULT_COMPARE_SOURCE
      ? {
          compareSource: editor.compareSource as ScriptStep["compareSource"],
        }
      : {}),
    ...(editor.operator !== DEFAULT_SCRIPT_OPERATOR
      ? { operator: editor.operator as ScriptStep["operator"] }
      : {}),
    ...(editor.expected ? { expected: editor.expected } : {}),
    // Kept as held: an authored `{{name}}` must not be rewritten to `true`.
    ...(editor.ignoreCase ? { ignoreCase: editor.ignoreCase } : {}),
    ...(editor.executionMode !== undefined
      ? { executionMode: editor.executionMode }
      : {}),
    ...(editor.shell?.trim() ? { shell: editor.shell } : {}),
    ...(editor.color !== undefined ? { color: editor.color } : {}),
    ...stepEnabledPatch(editor.enabled),
  };

  const clearProperties = [
    ...(!editor.env || Object.keys(editor.env).length === 0 ? ["env"] : []),
    ...(editor.secrets === undefined ||
    (Array.isArray(editor.secrets) && editor.secrets.length === 0)
      ? ["secrets"]
      : []),
    ...(editor.errorBehavior === undefined ? ["errorBehavior"] : []),
    ...(editor.timeoutSec === undefined ? ["timeoutSec"] : []),
    ...(editor.onPass === CONDITION_ACTIONS.CONTINUE ? ["onPass"] : []),
    ...(editor.onFail === CONDITION_ACTIONS.STOP_WORKFLOW ? ["onFail"] : []),
    ...(editor.compareSource === DEFAULT_COMPARE_SOURCE
      ? ["compareSource"]
      : []),
    ...(editor.operator === DEFAULT_SCRIPT_OPERATOR ? ["operator"] : []),
    ...(!editor.expected ? ["expected"] : []),
    ...(!editor.ignoreCase ? ["ignoreCase"] : []),
    ...(editor.executionMode === undefined ? ["executionMode"] : []),
    ...(!editor.shell?.trim() ? ["shell"] : []),
    ...(editor.color === undefined ? ["color"] : []),
    ...(editor.enabled === true ? ["enabled"] : []),
    ...(!editor.promptName.trim() ? ["name"] : []),
  ];

  return { properties, clearProperties };
}

/**
 * The editor fields a script step is built from. `EditorState` satisfies it,
 * so callers pass the store's state.
 */
export interface ScriptStepEditorContent {
  scriptEnv: ScriptStepEditorValues["env"];
  properties: {
    secrets?: ScriptStepEditorValues["secrets"];
    errorBehavior?: ScriptStepEditorValues["errorBehavior"];
    color?: ScriptStepEditorValues["color"];
  };
  scriptTimeoutSec: ScriptStepEditorValues["timeoutSec"];
  scriptOnPass: string;
  scriptOnFail: string;
  scriptCompareSource: string;
  scriptOperator: string;
  scriptExpected: string;
  scriptIgnoreCase: boolean;
  scriptExecutionMode: ScriptStepEditorValues["executionMode"];
  scriptShell: ScriptStepEditorValues["shell"];
  stepEnabled: StepEnabledValue;
  promptName: string;
}

/**
 * The single mapping from editor fields to a script step's values, shared by
 * the editor's save and dispatch paths, the execution preview, and an inline
 * workflow step's wrapped script.
 */
export function getScriptStepEditorValues(
  editor: ScriptStepEditorContent
): ScriptStepEditorValues {
  return {
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
  };
}

/** The script step property update for the editor's current content. */
export function getScriptStepUpdateFromEditor(
  editor: ScriptStepEditorContent
): ScriptStepPropertyUpdate {
  return getScriptStepPropertyUpdate(getScriptStepEditorValues(editor));
}
