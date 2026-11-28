import React, { useCallback } from "react";
import { editorTargetKey, useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useWorkflowFilePicker } from "@hooks/useSubWorkflowFilePicker";
import {
  CONDITION_ACTIONS,
  STEP_COLOR_MODES,
  SUB_WORKFLOW_EDITOR_LABELS,
} from "@root/types/DashboardConstants";
import {
  SCRIPT_STEP_CONDITION_ACTION_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";
import { MESSAGE_TYPES } from "../../types/messages";
import type {
  NormalizeSubWorkflowStepFileMessage,
  SelectSubWorkflowStepFileMessage,
} from "@root/types/WebviewMessageTypes";
import { schemaAriaLabel, schemaTitle } from "@utils/schemaPropertyLabels";
import { CustomSelect } from "../shared/CustomSelect";
import { Button } from "../shared/Button";
import { Icon } from "../shared/Icon";
import { WorkflowVariableValue } from "../shared/WorkflowVariableValue";
import { toForwardSlashPath } from "../shared/fileBrowserShared";
import { StepColorField } from "./StepColorField";

/**
 * Control ids, kept as literals in webview source: the schema round-trip
 * suite (`schemaUiPropertyRoundTrip`) scans this tree for them, so a removed
 * control fails there instead of leaving its property uneditable.
 */
export const SUB_WORKFLOW_EDITOR_CONTROL_IDS = {
  file: "sub-workflow-step-file",
  browse: "sub-workflow-step-browse",
  onFail: "sub-workflow-step-on-fail",
} as const;

const WORKFLOW_PATH_SCHEMA_PATH = "steps[].workflow";
const ON_FAIL_SCHEMA_PATH = "steps[].onFail";
const ON_FAIL_OPTIONS = toSelectOptions(
  SCRIPT_STEP_CONDITION_ACTION_OPTIONS_META,
  ON_FAIL_SCHEMA_PATH
);

interface SubWorkflowStepFieldsProps {
  disabled: boolean;
}

/**
 * The step editor's Workflow mode: a file-reference sub-workflow step's
 * `workflow` path (typed, with `/` separators, or picked), its `onFail`,
 * and its color. Name and enabled live in the editor header, shared with
 * every step kind. A step whose workflow is defined inline is shown
 * read-only.
 */
export const SubWorkflowStepFields: React.FC<SubWorkflowStepFieldsProps> = ({
  disabled,
}) => {
  const vscode = useVsCodeApi();
  const subWorkflowPath = useEditorStore((s) => s.subWorkflowPath);
  const subWorkflowOnFail = useEditorStore((s) => s.subWorkflowOnFail);
  const subWorkflowInline = useEditorStore((s) => s.subWorkflowInline);
  const pathError = useEditorStore((s) => s.validationErrors.subWorkflowPath);
  const setSubWorkflowPath = useEditorStore((s) => s.setSubWorkflowPath);
  const setSubWorkflowOnFail = useEditorStore((s) => s.setSubWorkflowOnFail);
  const stepColorMode = useSettingsStore((s) => s.globalSettings.stepColorMode);

  // Both pickers answer through the backend, which builds the reference the
  // step stores exactly as the queue entries build theirs (workspace-relative,
  // refused outside the workspace), so the panel and the hosted browser save
  // the same path. The request names the editor target it was made for; the
  // reply echoes it and is dropped if the editor has moved on
  // (SUB_WORKFLOW_STEP_FILE_SELECTED in the inbound router).
  const requestNativePick = useCallback(
    (targetKey: string) => {
      const message: SelectSubWorkflowStepFileMessage = {
        type: MESSAGE_TYPES.SELECT_SUB_WORKFLOW_STEP_FILE,
        targetKey,
      };
      vscode.postMessage(message);
    },
    [vscode]
  );
  const { requestWorkflowFile, workflowFilePickerModal } =
    useWorkflowFilePicker<string>({
      requestNativePick,
      modalLabels: () => ({
        title: SUB_WORKFLOW_EDITOR_LABELS.pickerTitle,
        actionLabel: SUB_WORKFLOW_EDITOR_LABELS.pickerAction,
      }),
      onHostedSelect: (filePath, targetKey) => {
        const message: NormalizeSubWorkflowStepFileMessage = {
          type: MESSAGE_TYPES.NORMALIZE_SUB_WORKFLOW_STEP_FILE,
          filePath,
          targetKey,
        };
        vscode.postMessage(message);
      },
    });

  const colorField = stepColorMode !== STEP_COLOR_MODES.NONE && (
    <div className="mt-4 rounded-sm border border-panel-border p-3">
      <StepColorField idPrefix="sub-workflow-step" />
    </div>
  );

  if (subWorkflowInline !== null) {
    const inlineText =
      "prompt" in subWorkflowInline
        ? subWorkflowInline.prompt
        : subWorkflowInline.script;
    return (
      <div className="flex flex-col gap-2">
        <div
          role="note"
          className="flex items-start gap-1.5 text-xs text-description-fg"
        >
          <Icon name="info" className="mt-px shrink-0" />
          <span>{SUB_WORKFLOW_EDITOR_LABELS.inlineReadOnly}</span>
        </div>
        <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded-sm border border-panel-border bg-code-block p-2 text-xs text-foreground">
          {inlineText}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label
          htmlFor={SUB_WORKFLOW_EDITOR_CONTROL_IDS.file}
          className="text-xs font-medium text-foreground"
          title={schemaTitle(
            WORKFLOW_PATH_SCHEMA_PATH,
            undefined,
            SUB_WORKFLOW_EDITOR_LABELS.fileTitle
          )}
        >
          {SUB_WORKFLOW_EDITOR_LABELS.file}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            id={SUB_WORKFLOW_EDITOR_CONTROL_IDS.file}
            aria-label={schemaAriaLabel(
              SUB_WORKFLOW_EDITOR_LABELS.file,
              WORKFLOW_PATH_SCHEMA_PATH
            )}
            aria-invalid={pathError ? true : undefined}
            value={subWorkflowPath}
            onChange={(event) =>
              setSubWorkflowPath(toForwardSlashPath(event.target.value))
            }
            placeholder={SUB_WORKFLOW_EDITOR_LABELS.filePlaceholder}
            disabled={disabled}
            spellCheck={false}
            className="min-w-0 flex-1 px-2 py-1 text-sm font-mono bg-input-bg text-input-fg border border-input-border rounded-sm focus:outline-hidden focus:border-focus-border disabled:opacity-50"
          />
          <Button
            id={SUB_WORKFLOW_EDITOR_CONTROL_IDS.browse}
            variant="secondary"
            size="sm"
            onClick={() =>
              requestWorkflowFile(
                editorTargetKey(useEditorStore.getState().selectionTarget)
              )
            }
            disabled={disabled}
            title={SUB_WORKFLOW_EDITOR_LABELS.browseTitle}
          >
            {SUB_WORKFLOW_EDITOR_LABELS.browse}
          </Button>
        </div>
        {pathError && (
          <span className="text-xs text-error-fg" role="alert">
            {pathError}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor={SUB_WORKFLOW_EDITOR_CONTROL_IDS.onFail}
          className="text-xs font-medium text-foreground"
          title={schemaTitle(
            ON_FAIL_SCHEMA_PATH,
            undefined,
            SUB_WORKFLOW_EDITOR_LABELS.onFailTitle
          )}
        >
          {SUB_WORKFLOW_EDITOR_LABELS.onFail}
        </label>
        <WorkflowVariableValue
          value={subWorkflowOnFail}
          label={SUB_WORKFLOW_EDITOR_LABELS.onFail}
          onClear={() => setSubWorkflowOnFail(CONDITION_ACTIONS.STOP_WORKFLOW)}
          disabled={disabled}
        >
          <CustomSelect
            id={SUB_WORKFLOW_EDITOR_CONTROL_IDS.onFail}
            value={subWorkflowOnFail}
            onChange={setSubWorkflowOnFail}
            options={ON_FAIL_OPTIONS}
            disabled={disabled}
            schemaPath={ON_FAIL_SCHEMA_PATH}
          />
        </WorkflowVariableValue>
      </div>
      {colorField}
      {workflowFilePickerModal}
    </div>
  );
};
