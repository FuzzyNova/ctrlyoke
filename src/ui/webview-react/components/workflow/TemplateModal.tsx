import React, { useState, useEffect, useCallback, useRef } from "react";
import { Modal, Button } from "../shared";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";

interface TemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * TemplateModal - Modal for creating a workflow from a template
 *
 * Data flow:
 *   1. Extension sends OPEN_NEW_WORKFLOW_MODAL → useMessageHandler opens modal via uiStore
 *   2. Template list and default template already in uiStore.templates / uiStore.defaultTemplateId
 *   3. uiStore.currentTemplate holds the selected template (with variables list)
 *   4. On template change, modal updates uiStore.currentTemplate directly from the local list
 *   5. On submit, sends CREATE_WORKFLOW → extension creates file, loads it, sends WORKFLOW_CREATED
 *   6. WORKFLOW_CREATED → useMessageHandler closes modal
 *
 * Features:
 * - Template dropdown (Built-in / Custom / Actions groups)
 * - Dynamic variable inputs based on selected template
 * - Filename input with validation
 * - Save location path preview
 * - Set as Default link
 * - Create and Create & Run buttons
 */
export const TemplateModal: React.FC<TemplateModalProps> = ({
  isOpen,
  onClose,
}) => {
  const vscode = useVsCodeApi();
  const filenameRef = useRef<HTMLInputElement>(null);

  // Data from uiStore (populated by useMessageHandler on OPEN_NEW_WORKFLOW_MODAL)
  const templates = useUiStore((s) => s.templates);
  const workflowsDir = useUiStore((s) => s.workflowsDir);
  const defaultTemplateId = useUiStore((s) => s.defaultTemplateId);
  const currentTemplate = useUiStore((s) => s.currentTemplate);
  const setCurrentTemplate = useUiStore((s) => s.setCurrentTemplate);
  const setDefaultTemplateId = useUiStore((s) => s.setDefaultTemplateId);

  // Local form state
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [filename, setFilename] = useState("");
  const [filenameError, setFilenameError] = useState<string | null>(null);
  const [defaultConfirmation, setDefaultConfirmation] = useState(false);

  // Initialize form state when modal opens
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      const initId = defaultTemplateId || "blank";
      setSelectedTemplateId(initId);
      setVariables({});
      setFilename("");
      setFilenameError(null);
      setDefaultConfirmation(false);

      // Sync currentTemplate to match the default selection
      const template = templates.find((t) => t.id === initId) ?? null;
      setCurrentTemplate(template);
    }
    prevIsOpenRef.current = isOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Focus filename input when modal opens
  useEffect(() => {
    if (isOpen && filenameRef.current) {
      setTimeout(() => filenameRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Handle template selection change
  const handleTemplateChange = useCallback(
    (templateId: string) => {
      if (templateId === "__create_new__") {
        onClose();
        vscode.postMessage({ type: MESSAGE_TYPES.CREATE_NEW_TEMPLATE });
        return;
      }

      setSelectedTemplateId(templateId);
      setVariables({});

      // Update currentTemplate directly from the local list (no round-trip needed)
      const template = templates.find((t) => t.id === templateId) ?? null;
      setCurrentTemplate(template);
    },
    [vscode, onClose, templates, setCurrentTemplate]
  );

  // Handle variable change
  const handleVariableChange = useCallback(
    (variable: string, value: string) => {
      setVariables((prev) => ({ ...prev, [variable]: value }));
    },
    []
  );

  // Validate filename
  const validateFilename = useCallback((name: string): boolean => {
    if (!name.trim()) {
      setFilenameError("Workflow name is required");
      return false;
    }

    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(name)) {
      setFilenameError("Invalid characters in filename");
      return false;
    }

    const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
    if (reserved.test(name)) {
      setFilenameError("Reserved filename");
      return false;
    }

    setFilenameError(null);
    return true;
  }, []);

  // Handle filename change
  const handleFilenameChange = useCallback(
    (value: string) => {
      setFilename(value);
      if (value) {
        validateFilename(value);
      } else {
        setFilenameError(null);
      }
    },
    [validateFilename]
  );

  // Set as default template (optimistic UI + persist via extension)
  const handleSetDefault = useCallback(() => {
    if (!selectedTemplateId || selectedTemplateId === "__create_new__") return;

    vscode.postMessage({
      type: MESSAGE_TYPES.SET_DEFAULT_TEMPLATE,
      templateId: selectedTemplateId,
    });

    // Optimistic update
    setDefaultTemplateId(selectedTemplateId);
    setDefaultConfirmation(true);
    setTimeout(() => setDefaultConfirmation(false), 2000);
  }, [vscode, selectedTemplateId, setDefaultTemplateId]);

  // Submit workflow creation
  const handleSubmit = useCallback(
    (runAfter: boolean) => {
      if (!validateFilename(filename)) return;

      vscode.postMessage({
        type: MESSAGE_TYPES.CREATE_WORKFLOW,
        templateId: selectedTemplateId,
        variables,
        filename: filename.trim(),
        workflowsDir,
        runAfter,
      });
    },
    [vscode, selectedTemplateId, variables, filename, workflowsDir, validateFilename]
  );

  // Keyboard handling
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        if (e.ctrlKey) {
          handleSubmit(true); // Create & Run
        } else if (e.target instanceof HTMLInputElement) {
          handleSubmit(false); // Create
        }
      }
    },
    [handleSubmit]
  );

  // Group templates for display
  const builtInTemplates = templates.filter((t) => t.isBuiltIn);
  const customTemplates = templates.filter((t) => !t.isBuiltIn && !t.isAction);
  const actionTemplates = templates.filter((t) => t.isAction);

  // Path preview
  const pathPreview = filename.trim()
    ? `${workflowsDir}/${filename.trim()}.flightpath.json`
    : `${workflowsDir}/`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create Workflow from Template"
      size="lg"
      footer={
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            {selectedTemplateId && selectedTemplateId !== "__create_new__" && selectedTemplateId !== defaultTemplateId ? (
              <a
                onClick={handleSetDefault}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleSetDefault()}
                className="text-sm font-medium text-link-fg hover:underline cursor-pointer transition-colors"
                title="Set this as the default template"
              >
                Set as Default
              </a>
            ) : selectedTemplateId === defaultTemplateId && selectedTemplateId !== "__create_new__" ? (
              <span className="text-sm text-description-fg">Default template</span>
            ) : null}
            {defaultConfirmation && (
              <span className="text-xs text-notification-info-fg animate-pulse">
                ✓ Default set
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => handleSubmit(false)}
              disabled={!filename.trim() || !!filenameError}
            >
              Create
            </Button>
            <Button
              variant="primary"
              onClick={() => handleSubmit(true)}
              disabled={!filename.trim() || !!filenameError}
            >
              Create & Run
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4" onKeyDown={handleKeyDown}>
        {/* Template Selection */}
        <div className="form-group">
          <label
            htmlFor="template-select"
            className="block text-sm font-medium mb-1 text-foreground"
          >
            Template
          </label>
          <select
            id="template-select"
            value={selectedTemplateId}
            onChange={(e) => handleTemplateChange(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-dropdown-bg text-dropdown-fg border border-dropdown-border focus:outline-none focus:border-focus-border"
          >
            {builtInTemplates.length > 0 && (
              <optgroup label="Built-in Templates">
                {builtInTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </optgroup>
            )}

            {customTemplates.length > 0 && (
              <optgroup label="Custom Templates">
                {customTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </optgroup>
            )}

            {actionTemplates.length > 0 && (
              <optgroup label="Actions">
                {actionTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {/* Template Description */}
        {currentTemplate?.description && (
          <p className="text-sm text-description-fg italic">
            {currentTemplate.description}
          </p>
        )}

        {/* Template Variables */}
        {currentTemplate?.variables && currentTemplate.variables.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-foreground">Variables</h4>
            {currentTemplate.variables.map((variable) => (
              <div key={variable} className="form-group">
                <label
                  htmlFor={`var-${variable}`}
                  className="block text-sm mb-1 text-foreground"
                >
                  {variable}
                </label>
                <input
                  type="text"
                  id={`var-${variable}`}
                  value={variables[variable] || ""}
                  onChange={(e) =>
                    handleVariableChange(variable, e.target.value)
                  }
                  placeholder={`Enter ${variable}`}
                  className="w-full px-2 py-1.5 rounded bg-input-bg text-input-fg border border-input-border focus:outline-none focus:border-focus-border"
                />
              </div>
            ))}
          </div>
        )}

        {/* Workflow Name / Filename */}
        <div className="form-group">
          <label
            htmlFor="workflow-name"
            className="block text-sm font-medium mb-1 text-foreground"
          >
            Workflow Name
          </label>
          <input
            ref={filenameRef}
            type="text"
            id="workflow-name"
            value={filename}
            onChange={(e) => handleFilenameChange(e.target.value)}
            placeholder="my-workflow"
            className={`w-full px-2 py-1.5 rounded bg-input-bg text-input-fg border focus:outline-none ${
              filenameError
                ? "border-input-error-border"
                : "border-input-border focus:border-focus-border"
            }`}
          />
          {filenameError && (
            <p className="mt-1 text-xs text-error-fg">{filenameError}</p>
          )}
        </div>

        {/* Path Preview */}
        <div className="form-group">
          <label className="block text-sm mb-1 text-description-fg">
            Save Location
          </label>
          <p className="text-xs text-description-fg font-mono bg-editor-bg px-2 py-1 rounded">
            {pathPreview}
          </p>
        </div>
      </div>
    </Modal>
  );
};
