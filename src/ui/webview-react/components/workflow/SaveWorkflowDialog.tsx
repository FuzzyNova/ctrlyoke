import React, { useState, useEffect, useCallback, useRef } from "react";
import { Modal, Button, ScopeToggle, SettingToggleRow } from "../shared";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import {
  MESSAGE_TYPES,
  WORKFLOW_FILE_FORMATS,
  type WorkflowFileFormat,
} from "../../types/messages";
import { validateSafeName } from "@utils/string";
import { type TemplateScope, TEMPLATE_SCOPE_OPTIONS } from "./templateScope";
import { TEMPLATE_FORMAT_OPTIONS } from "./templateFormat";
import {
  KEYBOARD_KEYS,
  SETTING_SCOPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";

/**
 * Split a full save path into its directory (`location`) and basename
 * without the `.ctrlyoke.<format>` extension (`name`). Handles both forward-
 * and back-slash separators (the extension may send an OS-native path).
 */
function splitSavePath(fullPath: string): { location: string; name: string } {
  const normalized = fullPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const location = lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
  const base = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const name = base.replace(/\.ctrlyoke\.(yaml|yml|json)$/i, "");
  return { location, name };
}

/** Rejoin a location + name + format into the full save path SAVE_WORKFLOW expects. */
function joinSavePath(
  location: string,
  name: string,
  format: WorkflowFileFormat
): string {
  const trimmedLocation = location.replace(/\/$/, "");
  const fileName = `${name}.ctrlyoke.${format}`;
  return trimmedLocation ? `${trimmedLocation}/${fileName}` : fileName;
}

/**
 * SaveWorkflowDialog
 *
 * Modal dialog for saving the current workflow as a .ctrlyoke.yaml or
 * .ctrlyoke.yaml or .ctrlyoke.json file. Runtime fields (_runtime, status,
 * id, etc.) are
 * stripped by the extension before writing.
 *
 * Flow:
 *   User clicks Save button
 *   → extension receives SAVE_WORKFLOW_REQUEST, reads working file, replies with SAVE_WORKFLOW_DIALOG_DATA
 *   → useMessageHandler opens this dialog (openSaveWorkflowDialog)
 *   → user edits location / name / format, clicks Save
 *   → extension receives SAVE_WORKFLOW, writes file, replies with WORKFLOW_SAVED or WORKFLOW_SAVE_FAILED
 *   → useMessageHandler closes dialog (on success) or shows toast error (on failure)
 *
 * Toggling "Save as Template" swaps the location/name/format fields for a
 * template name + scope + format picker and posts SAVE_WORKFLOW_AS_TEMPLATE instead —
 * the extension snapshots the current values (no {placeholder} conversion)
 * into a new custom template and replies with WORKFLOW_SAVED_AS_TEMPLATE or
 * (reused) WORKFLOW_SAVE_FAILED.
 *
 * Location's Browse button branches on isStandalone like TemplateModal's
 * variable pickers: VS Code panel → native OS folder dialog
 * (BROWSE_SAVE_LOCATION / SAVE_LOCATION_SELECTED); hosted browser → the
 * shared web FileBrowserModal (uiStore.openFileBrowser), since a native
 * dialog would open invisibly on the host's screen.
 */
export const SaveWorkflowDialog: React.FC = () => {
  const vscode = useVsCodeApi();
  const saveWorkflowDialogOpen = useUiStore((s) => s.saveWorkflowDialogOpen);
  const saveWorkflowDialogData = useUiStore((s) => s.saveWorkflowDialogData);
  const closeSaveWorkflowDialog = useUiStore((s) => s.closeSaveWorkflowDialog);
  const savePathCheck = useUiStore((s) => s.savePathCheck);
  const beginSavePathCheck = useUiStore((s) => s.beginSavePathCheck);
  const clearSavePathCheck = useUiStore((s) => s.clearSavePathCheck);
  const fileBrowserState = useUiStore((s) => s.fileBrowserState);
  const openFileBrowser = useUiStore((s) => s.openFileBrowser);
  const saveLocationSelection = useUiStore((s) => s.saveLocationSelection);
  const setSaveLocationSelection = useUiStore(
    (s) => s.setSaveLocationSelection
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const pathCheckSequence = useRef(0);

  const [location, setLocation] = useState("");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [format, setFormat] = useState<WorkflowFileFormat>(
    WORKFLOW_FILE_FORMATS.YAML
  );
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateNameError, setTemplateNameError] = useState<string | null>(
    null
  );
  const [templateScope, setTemplateScope] =
    useState<TemplateScope>("workspace");
  const [templateFormat, setTemplateFormat] = useState<WorkflowFileFormat>(
    WORKFLOW_FILE_FORMATS.YAML
  );

  // Reset local state whenever the dialog is opened with new data.
  useEffect(() => {
    if (saveWorkflowDialogOpen && saveWorkflowDialogData) {
      const { location: loc, name: baseName } = splitSavePath(
        saveWorkflowDialogData.defaultPath
      );
      setFormat(saveWorkflowDialogData.defaultFormat);
      setLocation(loc);
      setName(baseName);
      setNameError(null);
      setSaveAsTemplate(false);
      setTemplateName("");
      setTemplateNameError(null);
      setTemplateScope("workspace");
      setTemplateFormat(WORKFLOW_FILE_FORMATS.YAML);
    }
  }, [saveWorkflowDialogOpen, saveWorkflowDialogData]);

  // Auto-focus the input when the dialog opens.
  useEffect(() => {
    if (saveWorkflowDialogOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [saveWorkflowDialogOpen]);

  // Consume a location picked via the native OS folder dialog (VS Code panel).
  useEffect(() => {
    if (!saveLocationSelection) return;
    setLocation(saveLocationSelection.path);
    setSaveLocationSelection(null);
  }, [saveLocationSelection, setSaveLocationSelection]);

  const handleBrowseLocation = useCallback(() => {
    if (isStandalone) {
      openFileBrowser({
        mode: "directory",
        initialPath: location,
        onSelect: setLocation,
      });
      return;
    }
    vscode.postMessage({
      type: MESSAGE_TYPES.BROWSE_SAVE_LOCATION,
      defaultDir: location,
    });
  }, [vscode, openFileBrowser, location]);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setName(val);
      setNameError(
        val ? validateSafeName(val, "Workflow name is required") : null
      );
    },
    []
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

  const workflowPreviewPath = joinSavePath(
    location,
    name.trim() || "…",
    format
  );

  // Check overwrite state as the destination changes. The store only accepts
  // the exact outstanding request, so responses from a prior name, dialog, or
  // addressed view cannot repaint this warning.
  useEffect(() => {
    if (
      !saveWorkflowDialogOpen ||
      !saveWorkflowDialogData ||
      saveAsTemplate ||
      !name.trim() ||
      !!nameError
    ) {
      clearSavePathCheck();
      return;
    }
    pathCheckSequence.current += 1;
    const requestId = `${saveWorkflowDialogData.requestId}:path:${pathCheckSequence.current}`;
    beginSavePathCheck(
      requestId,
      workflowPreviewPath,
      saveWorkflowDialogData.address
    );
    vscode.postMessage({
      type: MESSAGE_TYPES.CHECK_SAVE_PATH,
      requestId,
      path: workflowPreviewPath,
      address: saveWorkflowDialogData.address,
    });
  }, [
    beginSavePathCheck,
    clearSavePathCheck,
    format,
    location,
    name,
    nameError,
    saveAsTemplate,
    saveWorkflowDialogData,
    saveWorkflowDialogOpen,
    vscode,
    workflowPreviewPath,
  ]);

  const matchingPathCheck =
    savePathCheck?.path === workflowPreviewPath &&
    saveWorkflowDialogData &&
    savePathCheck.address.workflowKey ===
      saveWorkflowDialogData.address.workflowKey &&
    savePathCheck.address.kind === saveWorkflowDialogData.address.kind &&
    (saveWorkflowDialogData.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT ||
      (saveWorkflowDialogData.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        savePathCheck.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        savePathCheck.address.runRef === saveWorkflowDialogData.address.runRef))
      ? savePathCheck
      : null;
  const bundlePreview = matchingPathCheck?.bundlePreview;

  const handleSave = useCallback(() => {
    if (saveAsTemplate) {
      const err = validateSafeName(templateName, "Template name is required");
      if (err) {
        setTemplateNameError(err);
        return;
      }
      vscode.postMessage({
        type: MESSAGE_TYPES.SAVE_WORKFLOW_AS_TEMPLATE,
        requestId: saveWorkflowDialogData?.requestId,
        address: saveWorkflowDialogData?.address,
        name: templateName.trim(),
        scope: templateScope,
        format: templateFormat,
      });
      return;
    }

    const err = validateSafeName(name, "Workflow name is required");
    if (err) {
      setNameError(err);
      return;
    }
    vscode.postMessage({
      type: MESSAGE_TYPES.SAVE_WORKFLOW,
      requestId: saveWorkflowDialogData?.requestId,
      address: saveWorkflowDialogData?.address,
      filePath: workflowPreviewPath,
      format,
      planFingerprint: bundlePreview?.planFingerprint,
      pathCheckRequestId: matchingPathCheck?.requestId,
    });
  }, [
    vscode,
    name,
    format,
    saveAsTemplate,
    templateName,
    templateScope,
    templateFormat,
    saveWorkflowDialogData,
    workflowPreviewPath,
    bundlePreview,
    matchingPathCheck?.requestId,
  ]);

  const pathReady =
    !!matchingPathCheck &&
    !matchingPathCheck.checking &&
    !matchingPathCheck.error &&
    !!bundlePreview &&
    bundlePreview.blockers.length === 0;
  const canSave = saveAsTemplate
    ? !!templateName.trim() && !templateNameError
    : !!name.trim() && !nameError && pathReady;

  // Preview of the final file path, shown at the bottom of the dialog so
  // the user can see exactly what will be written before hitting Save.
  const templateDirPreview =
    templateScope === SETTING_SCOPES.USER
      ? "~/.ctrlyoke/templates"
      : ".ctrlyoke/templates";
  const previewPath = saveAsTemplate
    ? `${templateDirPreview}/${templateName.trim() || "…"}.ctrlyoke.${templateFormat}`
    : workflowPreviewPath;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === KEYBOARD_KEYS.ENTER && canSave) {
        handleSave();
      }
    },
    [handleSave, canSave]
  );

  return (
    <Modal
      isOpen={saveWorkflowDialogOpen && !fileBrowserState}
      onClose={closeSaveWorkflowDialog}
      title={saveWorkflowDialogData?.title ?? "Save workflow"}
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
          This workflow is auto-saved to your working area as you edit. Use Save
          As to export a clean, shareable copy without runtime state.
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
              {Object.values(WORKFLOW_FILE_FORMATS).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  className={`px-4 py-1.5 text-sm font-medium transition-colors focus:outline-none ${
                    format === fmt
                      ? "bg-btn-bg text-btn-fg"
                      : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                  }`}
                  onClick={() => setFormat(fmt)}
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
              <p className="mt-1 text-xs text-error-fg">{templateNameError}</p>
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
            <div className="mt-3 flex items-center gap-2">
              <span className="text-sm text-foreground">Format</span>
              <ScopeToggle
                ariaLabel="Template format"
                value={templateFormat}
                onChange={setTemplateFormat}
                options={TEMPLATE_FORMAT_OPTIONS}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="form-group">
              <span className="block mb-1 text-sm font-medium text-foreground">
                Location
              </span>
              <div className="flex items-center gap-1.5">
                <span
                  className="flex-1 min-w-0 truncate px-2 py-1.5 rounded bg-input-bg text-input-fg border border-input-border font-mono text-xs"
                  title={location || "(workspace root)"}
                >
                  {location || "(workspace root)"}
                </span>
                <Button
                  variant="secondary"
                  onClick={handleBrowseLocation}
                  title="Browse for save location"
                >
                  Browse…
                </Button>
              </div>
              <p className="mt-1 text-xs text-description-fg">
                Absolute path or path relative to the workspace root.
              </p>
            </div>

            <div className="form-group">
              <label
                htmlFor="save-workflow-name"
                className="block text-sm font-medium text-foreground"
              >
                <span className="block mb-1">Name</span>
                <input
                  ref={inputRef}
                  id="save-workflow-name"
                  type="text"
                  aria-label="Name"
                  value={name}
                  onChange={handleNameChange}
                  onKeyDown={handleKeyDown}
                  spellCheck={false}
                  placeholder="my-workflow"
                  className={`w-full px-2 py-1.5 rounded bg-input-bg text-input-fg border focus:outline-none font-mono text-xs ${
                    nameError
                      ? "border-input-error-border"
                      : "border-input-border focus:border-focus-border"
                  }`}
                />
              </label>
              {nameError && (
                <p className="mt-1 text-xs text-error-fg">{nameError}</p>
              )}
              {matchingPathCheck?.checking && (
                <p className="mt-1 text-xs text-description-fg">
                  Checking destination…
                </p>
              )}
              {matchingPathCheck?.error && (
                <p className="mt-1 text-xs text-error-fg">
                  {matchingPathCheck.error}
                </p>
              )}
              {matchingPathCheck?.exists && !matchingPathCheck.error && (
                <p className="mt-1 text-xs text-warning-fg" role="alert">
                  A workflow already exists at this path and will be
                  overwritten.
                </p>
              )}
              {matchingPathCheck?.planChanged && bundlePreview && (
                <p className="mt-1 text-xs text-warning-fg" role="alert">
                  The bundle changed while saving. Review the updated plan and
                  confirm again.
                </p>
              )}
            </div>
          </>
        )}

        {!saveAsTemplate && matchingPathCheck?.checking && (
          <p className="text-sm text-description-fg">Analyzing bundle…</p>
        )}

        {!saveAsTemplate && bundlePreview && !matchingPathCheck?.checking && (
          <div className="space-y-1.5 text-sm" aria-label="Bundle preview">
            {bundlePreview.copyCount > 0 && (
              <p>
                {bundlePreview.copyCount} attachment
                {bundlePreview.copyCount === 1 ? "" : "s"} will be copied to{" "}
                <span className="font-mono">
                  {bundlePreview.assetsDirectoryName ?? "the assets folder"}/
                </span>
              </p>
            )}
            {bundlePreview.inlineCount > 0 && (
              <p>
                {bundlePreview.inlineCount} prompt file
                {bundlePreview.inlineCount === 1 ? "" : "s"} will be inlined
              </p>
            )}
            {bundlePreview.pruneCount > 0 && (
              <p className="text-warning-fg">
                {bundlePreview.pruneCount} managed asset
                {bundlePreview.pruneCount === 1 ? "" : "s"} will be removed
              </p>
            )}
            {bundlePreview.copyCount === 0 &&
              bundlePreview.inlineCount === 0 &&
              bundlePreview.pruneCount === 0 &&
              bundlePreview.warnings.length === 0 &&
              bundlePreview.blockers.length === 0 && (
                <p className="text-description-fg">
                  No bundle changes are required.
                </p>
              )}
            {bundlePreview.warnings.map((warning) => (
              <p
                key={`warning-${warning.code}-${warning.message}`}
                className="text-warning-fg"
                role="alert"
              >
                Warning: {warning.message}
              </p>
            ))}
            {bundlePreview.blockers.map((blocker) => (
              <p
                key={`blocker-${blocker.code}-${blocker.message}`}
                className="text-error-fg"
                role="alert"
              >
                Cannot save: {blocker.message}
              </p>
            ))}
          </div>
        )}

        <div className="pt-3 border-t border-panel-border">
          <p className="text-xs text-description-fg">
            Will save to{" "}
            <span className="font-mono text-foreground break-all">
              {previewPath}
            </span>
          </p>
        </div>
      </div>
    </Modal>
  );
};
