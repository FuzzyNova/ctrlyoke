import React, { useCallback } from "react";
import { editorTargetKey, useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useWorkflowFilePicker } from "@hooks/useSubWorkflowFilePicker";
import {
  CONDITION_ACTIONS,
  STEP_COLOR_MODES,
  STEP_EDITOR_MODE_LABELS,
  STEP_TYPES,
  SUB_WORKFLOW_EDITOR_FORMS,
  SUB_WORKFLOW_EDITOR_LABELS,
  type SubWorkflowEditorForm,
} from "@root/types/DashboardConstants";
import type { InlineSubWorkflowStepKind } from "@root/types/CtrlYokeTypes";
import {
  INLINE_SUB_WORKFLOW_WORKTREE_SELECTION_OPTIONS_META,
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
import { ModeSwitch, type ModeSwitchOption } from "../shared/ModeSwitch";
import { WorktreeConfigEditor } from "../shared/WorktreeConfigEditor";
import { getStepKindIconClass } from "@utils/status";
import { WorkflowVariableValue } from "../shared/WorkflowVariableValue";
import { toForwardSlashPath } from "../shared/fileBrowserShared";
import { StepColorField } from "./StepColorField";

/**
 * Control ids, kept as literals in webview source: the schema round-trip
 * suite (`schemaUiPropertyRoundTrip`) scans this tree for them, so a removed
 * control fails there instead of leaving its property uneditable.
 */
export const SUB_WORKFLOW_EDITOR_CONTROL_IDS = {
  formFile: "sub-workflow-step-form-file",
  formInline: "sub-workflow-step-form-inline",
  inlinePrompt: "sub-workflow-step-inline-prompt",
  inlineScript: "sub-workflow-step-inline-script",
  file: "sub-workflow-step-file",
  browse: "sub-workflow-step-browse",
  onFail: "sub-workflow-step-on-fail",
  /** Prefixes the shared worktree editor's ids (`…-worktree-mode`, …). */
  worktree: "sub-workflow-step",
} as const;

const FORM_OPTIONS: readonly ModeSwitchOption<SubWorkflowEditorForm>[] = [
  {
    value: SUB_WORKFLOW_EDITOR_FORMS.FILE,
    id: SUB_WORKFLOW_EDITOR_CONTROL_IDS.formFile,
    label: SUB_WORKFLOW_EDITOR_LABELS.formFile,
    title: SUB_WORKFLOW_EDITOR_LABELS.formFileTitle,
    icon: "file",
  },
  {
    value: SUB_WORKFLOW_EDITOR_FORMS.INLINE,
    id: SUB_WORKFLOW_EDITOR_CONTROL_IDS.formInline,
    label: SUB_WORKFLOW_EDITOR_LABELS.formInline,
    title: SUB_WORKFLOW_EDITOR_LABELS.formInlineTitle,
    icon: "edit",
  },
];

const INLINE_KIND_OPTIONS: readonly ModeSwitchOption<InlineSubWorkflowStepKind>[] =
  [
    {
      value: STEP_TYPES.PROMPT,
      id: SUB_WORKFLOW_EDITOR_CONTROL_IDS.inlinePrompt,
      icon: getStepKindIconClass(STEP_TYPES.PROMPT),
      ...STEP_EDITOR_MODE_LABELS[STEP_TYPES.PROMPT],
    },
    {
      value: STEP_TYPES.SCRIPT,
      id: SUB_WORKFLOW_EDITOR_CONTROL_IDS.inlineScript,
      icon: getStepKindIconClass(STEP_TYPES.SCRIPT),
      ...STEP_EDITOR_MODE_LABELS[STEP_TYPES.SCRIPT],
    },
  ];

const INLINE_WORKTREE_OPTIONS = toSelectOptions(
  INLINE_SUB_WORKFLOW_WORKTREE_SELECTION_OPTIONS_META,
  "worktree"
);

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
 * Workflow mode's form switches: File / Inline, and for an inline
 * definition (D13) the step it wraps, Prompt / Script. The form is read from
 * the step's `workflow` shape; the wrapped step is edited in the prompt or
 * script editor below.
 */
export const SubWorkflowFormBar: React.FC<SubWorkflowStepFieldsProps> = ({
  disabled,
}) => {
  const inline = useEditorStore((s) => s.subWorkflowInline);
  const setSubWorkflowForm = useEditorStore((s) => s.setSubWorkflowForm);
  const setSubWorkflowInlineKind = useEditorStore(
    (s) => s.setSubWorkflowInlineKind
  );
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-panel-border bg-editor-bg px-3 py-1.5 cy-no-select">
      <ModeSwitch
        ariaLabel={SUB_WORKFLOW_EDITOR_LABELS.form}
        options={FORM_OPTIONS}
        value={
          inline === null
            ? SUB_WORKFLOW_EDITOR_FORMS.FILE
            : SUB_WORKFLOW_EDITOR_FORMS.INLINE
        }
        onChange={setSubWorkflowForm}
        disabled={disabled}
      />
      {inline !== null && (
        <ModeSwitch
          ariaLabel={SUB_WORKFLOW_EDITOR_LABELS.inlineKind}
          options={INLINE_KIND_OPTIONS}
          value={inline.kind}
          onChange={setSubWorkflowInlineKind}
          disabled={disabled}
        />
      )}
    </div>
  );
};

/**
 * The step editor's Workflow-mode fields. The File form takes the
 * `workflow` path (typed, with `/` separators, or picked); the Inline form
 * takes the child's `worktree` through the workflow-level worktree editor.
 * Both take `onFail` and the color. Name and enabled live in the editor
 * header, shared with every step kind.
 */
export const SubWorkflowStepFields: React.FC<SubWorkflowStepFieldsProps> = ({
  disabled,
}) => {
  const vscode = useVsCodeApi();
  const subWorkflowPath = useEditorStore((s) => s.subWorkflowPath);
  const subWorkflowOnFail = useEditorStore((s) => s.subWorkflowOnFail);
  const subWorkflowInline = useEditorStore((s) => s.subWorkflowInline);
  const setSubWorkflowWorktree = useEditorStore(
    (s) => s.setSubWorkflowWorktree
  );
  const worktreeDefaults = useSettingsStore((s) => s.globalSettings.worktree);
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

  const fileField = (
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
  );

  return (
    <div className="flex flex-col gap-3">
      {subWorkflowInline === null ? (
        fileField
      ) : (
        <WorktreeConfigEditor
          idPrefix={SUB_WORKFLOW_EDITOR_CONTROL_IDS.worktree}
          label={SUB_WORKFLOW_EDITOR_LABELS.worktree}
          description={SUB_WORKFLOW_EDITOR_LABELS.worktreeTitle}
          value={subWorkflowInline.worktree}
          options={INLINE_WORKTREE_OPTIONS}
          seedDefaults={worktreeDefaults}
          onChange={(next) => setSubWorkflowWorktree(next)}
          disabled={disabled}
        />
      )}
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
      {subWorkflowInline === null && workflowFilePickerModal}
    </div>
  );
};
