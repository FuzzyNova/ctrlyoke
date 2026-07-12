import React, { useState, useEffect, useCallback, useRef } from "react";
import { Modal, Button, ScopeToggle, SettingToggleRow } from "../shared";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";
import { validateSafeName } from "@utils/string";
import { type TemplateScope, TEMPLATE_SCOPE_OPTIONS } from "./templateScope";

/**
 * SaveWorkflowDialog
 *
 * Modal dialog for saving the current workflow as a .ctrlyoke.yaml or
 * .ctrlyoke.json file. Runtime fields (_runtime, status, id, etc.) are
 * stripped by the extension before writing.
 *
 * Flow:
 *   User clicks Save button
 *   → extension receives SAVE_WORKFLOW_REQUEST, reads working file, replies with SAVE_WORKFLOW_DIALOG_DATA
 *   → useMessageHandler opens this dialog (openSaveWorkflowDialog)
 *   → user edits path / format, clicks Save
 *   → extension receives SAVE_WORKFLOW, writes file, replies with WORKFLOW_SAVED or WORKFLOW_SAVE_FAILED
 *   → useMessageHandler closes dialog (on success) or shows toast error (on failure)
 *
 * Toggling "Save as Template" swaps the path/format fields for a template
 * name + scope picker and posts SAVE_WORKFLOW_AS_TEMPLATE instead — the
 * extension snapshots the current values (no {placeholder} conversion) into
 * a new custom template and replies with WORKFLOW_SAVED_AS_TEMPLATE or
 * (reused) WORKFLOW_SAVE_FAILED.
 */
export const SaveWorkflowDialog: React.FC = () => {
  const vscode = useVsCodeApi();
  const saveWorkflowDialogOpen = useUiStore((s) => s.saveWorkflowDialogOpen);
  const saveWorkflowDialogData = useUiStore((s) => s.saveWorkflowDialogData);
  const closeSaveWorkflowDialog = useUiStore((s) => s.closeSaveWorkflowDialog);

  const inputRef = useRef<HTMLInputElement>(null);

  // Normalize a file path to use the given format extension.
  function applyFormat(p: string, fmt: "yaml" | "json"): string {
    const target = `.ctrlyoke.${fmt}`;
    return p
      .replace(/\.ctrlyoke\.(yaml|yml|json)$/i, target)
      .replace(/\.(yaml|yml|json)$/i, target);
  }

  const [filePath, setFilePath] = useState("");
  const [format, setFormat] = useState<"yaml" | "json">("yaml");
  const [pathError, setPathError] = useState<string | null>(null);
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateNameError, setTemplateNameError] = useState<string | null>(
    null
  );
  const [templateScope, setTemplateScope] =
    useState<TemplateScope>("workspace");

  // Reset local state whenever the dialog is opened with new data.
  useEffect(() => {
    if (saveWorkflowDialogOpen && saveWorkflowDialogData) {
      const fmt = saveWorkflowDialogData.defaultFormat;
      setFormat(fmt);
      setFilePath(saveWorkflowDialogData.defaultPath);
      setPathError(null);
      setSaveAsTemplate(false);
      setTemplateName("");
      setTemplateNameError(null);
      setTemplateScope("workspace");
    }
  }, [saveWorkflowDialogOpen, saveWorkflowDialogData]);

  // Auto-focus the input when the dialog opens.
  useEffect(() => {
    if (saveWorkflowDialogOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [saveWorkflowDialogOpen]);

  const handleFormatChange = useCallback((fmt: "yaml" | "json") => {
    setFormat(fmt);
    setFilePath((prev) => applyFormat(prev, fmt));
  }, []);

  const validate = useCallback((p: string): string | null => {
    if (!p.trim()) return "File path cannot be empty.";
    if (!p.match(/\.(ctrlyoke\.(yaml|yml|json)|prompt\.md)$/i)) {
      return "Path must end with .ctrlyoke.yaml, .ctrlyoke.yml, or .ctrlyoke.json.";
    }
    return null;
  }, []);

  const handlePathChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setFilePath(val);
      setPathError(validate(val));
    },
    [validate]
  );

  const handleTemplateNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setTemplateName(val);
      setTemplateNameError(
        val ? validateSafeName(val, "Template name is required") : null
      );
    },
    []
  );

  const handleSave = useCallback(() => {
    if (saveAsTemplate) {
      const err = validateSafeName(templateName, "Template name is required");
      if (err) {
        setTemplateNameError(err);
        return;
      }
      vscode.postMessage({
        type: MESSAGE_TYPES.SAVE_WORKFLOW_AS_TEMPLATE,
        name: templateName.trim(),
        scope: templateScope,
      });
      return;
    }

    const err = validate(filePath);
    if (err) {
      setPathError(err);
      return;
    }
    vscode.postMessage({
      type: MESSAGE_TYPES.SAVE_WORKFLOW,
      filePath: filePath.trim(),
      format,
    });
  }, [
    vscode,
    filePath,
    format,
    validate,
    saveAsTemplate,
    templateName,
    templateScope,
  ]);

  const canSave = saveAsTemplate
    ? !!templateName.trim() && !templateNameError
    : !!filePath.trim() && !pathError;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && canSave) {
        handleSave();
      }
    },
    [handleSave, canSave]
  );

  return (
    <Modal
      isOpen={saveWorkflowDialogOpen}
      onClose={closeSaveWorkflowDialog}
      title="Save Workflow As..."
      size="md"
      footer={
        <div className="flex items-center justify-between w-full">
          <span className="text-xs text-description-fg">
            Runtime state will not be saved.
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={closeSaveWorkflowDialog}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={!canSave}>
              <i className="codicon codicon-save mr-1.5" />
              Save
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-description-fg">
          This workflow is auto-saved to your working area as you edit. Use
          Save As to export a clean, shareable copy without runtime state.
        </p>

        <SettingToggleRow
          label="Save as Template"
          description="Save this workflow's current values as a reusable template instead of a workflow file."
          checked={saveAsTemplate}
          onChange={setSaveAsTemplate}
        />

        {/* Format selector */}
        {!saveAsTemplate && (
          <div className="form-group">
            <p
              id="format-label"
              className="block text-sm font-medium mb-2 text-foreground"
            >
              Format
            </p>
            <div
              role="group"
              aria-labelledby="format-label"
              className="inline-flex rounded border border-btn-border overflow-hidden"
            >
              {(["yaml", "json"] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  className={`px-4 py-1.5 text-sm font-medium transition-colors focus:outline-none ${
                    format === fmt
                      ? "bg-btn-bg text-btn-fg"
                      : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                  }`}
                  onClick={() => handleFormatChange(fmt)}
                >
                  {fmt.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        )}

        {saveAsTemplate ? (
          <div className="form-group">
            <label
              htmlFor="save-template-name"
              className="block text-sm font-medium text-foreground"
            >
              <span className="block mb-1">Template Name</span>
              <input
                ref={inputRef}
                id="save-template-name"
                type="text"
                aria-label="Template Name"
                value={templateName}
                onChange={handleTemplateNameChange}
                onKeyDown={handleKeyDown}
                placeholder="my-custom-template"
                className={`w-full px-2 py-1.5 rounded bg-input-bg text-input-fg border focus:outline-none ${
                  templateNameError
                    ? "border-input-error-border"
                    : "border-input-border focus:border-focus-border"
                }`}
              />
            </label>
            {templateNameError && (
              <p className="mt-1 text-xs text-error-fg">
                {templateNameError}
              </p>
            )}
            <div className="mt-3 flex items-center gap-2">
              <span className="text-sm text-foreground">Location</span>
              <ScopeToggle
                ariaLabel="Template location"
                value={templateScope}
                onChange={setTemplateScope}
                options={TEMPLATE_SCOPE_OPTIONS}
              />
            </div>
          </div>
        ) : (
          <div className="form-group">
            <label
              htmlFor="save-workflow-path"
              className="block text-sm font-medium text-foreground"
            >
              <span className="block mb-1">Save Path</span>
              <input
                ref={inputRef}
                id="save-workflow-path"
                type="text"
                aria-label="Save Path"
                value={filePath}
                onChange={handlePathChange}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                className={`w-full px-2 py-1.5 rounded bg-input-bg text-input-fg border focus:outline-none font-mono text-xs ${
                  pathError
                    ? "border-input-error-border"
                    : "border-input-border focus:border-focus-border"
                }`}
              />
            </label>
            {pathError && (
              <p className="mt-1 text-xs text-error-fg">{pathError}</p>
            )}
            <p className="mt-1 text-xs text-description-fg">
              Absolute path or path relative to the workspace root.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
};
