import React, { useState, useEffect, useCallback, useRef } from "react";
import { Modal, Button } from "../shared";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";

interface Template {
  id: string;
  name: string;
  description: string;
  variables?: string[];
  isBuiltIn: boolean;
  isAction?: boolean;
}

interface TemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TemplateModalData {
  templates: Template[];
  workflowsDir: string;
  defaultTemplateId: string;
}

/**
 * TemplateModal - Modal for creating workflow from template
 *
 * Features:
 * - Template dropdown with groups (Built-in, Custom, Actions)
 * - Dynamic variable inputs based on selected template
 * - Filename input with validation
 * - Path preview
 * - Set as Default checkbox
 * - Create and Create & Run buttons
 */
export const TemplateModal: React.FC<TemplateModalProps> = ({
  isOpen,
  onClose,
}) => {
  const vscode = useVsCodeApi();
  const filenameRef = useRef<HTMLInputElement>(null);

  // Modal data from extension
  const [modalData, setModalData] = useState<TemplateModalData>({
    templates: [],
    workflowsDir: ".flightpath/workflows",
    defaultTemplateId: "blank",
  });

  // Form state
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [filename, setFilename] = useState("");
  const [filenameError, setFilenameError] = useState<string | null>(null);
  const [defaultConfirmation, setDefaultConfirmation] = useState(false);

  // Get current template
  const currentTemplate = modalData.templates.find(
    (t) => t.id === selectedTemplateId
  );

  // Handle messages from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL:
          setModalData({
            templates: message.templates || [],
            workflowsDir: message.workflowsDir || ".flightpath/workflows",
            defaultTemplateId: message.defaultTemplateId || "blank",
          });
          setSelectedTemplateId(message.defaultTemplateId || "blank");
          setFilename("");
          setVariables({});
          setFilenameError(null);
          setDefaultConfirmation(false);
          break;

        case MESSAGE_TYPES.TEMPLATE_INFO:
          // Update template variables when received
          setModalData((prev) => ({
            ...prev,
            templates: prev.templates.map((t) =>
              t.id === message.templateId
                ? {
                    ...t,
                    variables: message.variables || [],
                    description: message.description || t.description,
                  }
                : t
            ),
          }));
          break;

        case MESSAGE_TYPES.DEFAULT_TEMPLATE_SET:
          if (message.success) {
            setModalData((prev) => ({
              ...prev,
              defaultTemplateId: message.templateId,
            }));
            setDefaultConfirmation(true);
            setTimeout(() => setDefaultConfirmation(false), 2000);
          }
          break;

        case MESSAGE_TYPES.WORKFLOW_CREATED:
          if (message.success) {
            onClose();
          } else {
            setFilenameError(message.error || "Failed to create workflow");
          }
          break;

        case MESSAGE_TYPES.CLOSE_MODAL:
          onClose();
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onClose]);

  // Focus filename input when modal opens
  useEffect(() => {
    if (isOpen && filenameRef.current) {
      setTimeout(() => filenameRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Handle template selection
  const handleTemplateChange = useCallback(
    (templateId: string) => {
      if (templateId === "__create_new__") {
        onClose();
        vscode.postMessage({ type: MESSAGE_TYPES.CREATE_NEW_TEMPLATE });
        return;
      }

      setSelectedTemplateId(templateId);
      setVariables({});

      // Request template info
      vscode.postMessage({
        type: MESSAGE_TYPES.TEMPLATE_SELECTED,
        templateId,
      });
    },
    [vscode, onClose]
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

    // Check for invalid characters
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(name)) {
      setFilenameError("Invalid characters in filename");
      return false;
    }

    // Check for reserved names (Windows)
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

  // Set as default template
  const handleSetDefault = useCallback(() => {
    if (selectedTemplateId && selectedTemplateId !== "__create_new__") {
      vscode.postMessage({
        type: MESSAGE_TYPES.SET_DEFAULT_TEMPLATE,
        templateId: selectedTemplateId,
      });
    }
  }, [vscode, selectedTemplateId]);

  // Submit workflow creation
  const handleSubmit = useCallback(
    (runAfter: boolean) => {
      if (!validateFilename(filename)) {
        return;
      }

      vscode.postMessage({
        type: MESSAGE_TYPES.CREATE_WORKFLOW,
        templateId: selectedTemplateId,
        variables,
        filename: filename.trim(),
        workflowsDir: modalData.workflowsDir,
        runAfter,
      });
    },
    [
      vscode,
      selectedTemplateId,
      variables,
      filename,
      modalData.workflowsDir,
      validateFilename,
    ]
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

  // Group templates
  const builtInTemplates = modalData.templates.filter((t) => t.isBuiltIn);
  const customTemplates = modalData.templates.filter(
    (t) => !t.isBuiltIn && !t.isAction
  );
  const actionTemplates = modalData.templates.filter((t) => t.isAction);

  // Path preview
  const pathPreview = filename.trim()
    ? `${modalData.workflowsDir}/${filename.trim()}.flightpath.json`
    : `${modalData.workflowsDir}/`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create Workflow from Template"
      size="lg"
      footer={
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <a
              onClick={handleSetDefault}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && handleSetDefault()}
              className={`text-sm font-medium text-link-fg hover:underline cursor-pointer transition-colors ${
                !selectedTemplateId || selectedTemplateId === "__create_new__"
                  ? "opacity-50 cursor-not-allowed pointer-events-none"
                  : ""
              }`}
              title="Set this as the default template"
            >
              Set as Default
            </a>
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
            {/* Built-in Templates */}
            {builtInTemplates.length > 0 && (
              <optgroup label="Built-in Templates">
                {builtInTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </optgroup>
            )}

            {/* Custom Templates */}
            {customTemplates.length > 0 && (
              <optgroup label="Custom Templates">
                {customTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </optgroup>
            )}

            {/* Actions */}
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
            <h4 className="text-sm font-medium text-foreground">
              Variables
            </h4>
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
            <p className="mt-1 text-xs text-error-fg">
              {filenameError}
            </p>
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
