import {
  KEYBOARD_KEYS,
  TEMPLATE_IDS,
  TEMPLATE_SOURCES,
  TEMPLATE_VARIABLE_TYPES,
  WORKSPACE_ENTRY_KINDS,
  DASHBOARD_HOST_CAPABILITIES,
  SETTING_SCOPES,
  TEMPLATE_VARIABLE_DEFAULT_SOURCES,
} from "@root/types/DashboardConstants";
import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  Modal,
  Button,
  AnimatedSection,
  ScopeToggle,
  SETTING_SCOPE_OPTIONS,
  LabelActionLink,
  FieldLabelRow,
  LABEL_ACTION_NOTE_CLASS,
} from "../shared";
import { useElementNarrow } from "@hooks/useElementNarrow";
import { useUiStore } from "@store/uiStore";
import type { TemplateInfo, TemplateVariable } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import {
  MESSAGE_TYPES,
  HARNESS_IDS,
  WORKFLOW_FILE_FORMATS,
  type HarnessId,
  type WorkflowFileFormat,
  type SettingWriteScope,
} from "../../types/messages";
import { defaultModelForHarness } from "@utils/harnessChangeCascade";
import { validateSafeName } from "@utils/string";
import { type TemplateScope, TEMPLATE_SCOPE_OPTIONS } from "./templateScope";
import { TEMPLATE_FORMAT_OPTIONS } from "./templateFormat";
import { Icon } from "../shared/Icon";
import { TemplateVariableField } from "./TemplateVariableField";

/** Below this content width the header's scope toggle drops its labels. */
const TEMPLATE_MODAL_NARROW_PX = 480;
const REQUIRED_VARIABLE_ERROR = "This field is required";

function isSatisfiedRequiredValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

interface TemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Build the initial variable values for a template, pre-filling declared defaults. */
function seedVariableDefaults(
  template: TemplateInfo | null
): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const variable of template?.variables ?? []) {
    if (variable.default !== undefined) {
      seed[variable.name] = variable.default;
    } else if (
      variable.type === TEMPLATE_VARIABLE_TYPES.SELECT &&
      variable.options?.length
    ) {
      // A dropdown with no explicit default pre-selects its first option.
      seed[variable.name] = variable.options[0];
    } else if (variable.type === TEMPLATE_VARIABLE_TYPES.HARNESS) {
      // No "unselected" state for a harness variable — it must always
      // substitute a valid HarnessId, so fall back to the first known one.
      seed[variable.name] = HARNESS_IDS.CLAUDE_CLI;
    }
  }
  return seed;
}

/**
 * Map each harness variable to the model variables that follow it. Only
 * pairings the extension validated (`harness` names a harness variable)
 * arrive here; an unpaired model variable renders as a text input.
 */
function modelVariablesByHarness(
  template: TemplateInfo | null
): Map<string, TemplateVariable[]> {
  const pairs = new Map<string, TemplateVariable[]>();
  for (const variable of template?.variables ?? []) {
    if (variable.type !== TEMPLATE_VARIABLE_TYPES.MODEL || !variable.harness)
      continue;
    pairs.set(variable.harness, [
      ...(pairs.get(variable.harness) ?? []),
      variable,
    ]);
  }
  return pairs;
}

/**
 * TemplateModal - Modal for creating a workflow from a template
 *
 * Data flow:
 *   1. Extension sends OPEN_NEW_WORKFLOW_MODAL → useMessageHandler opens modal via uiStore
 *   2. Template list and default template already in uiStore.templates / uiStore.defaultTemplateId
 *   3. uiStore.currentTemplate holds the selected template (with variables list)
 *   4. On template change, modal updates uiStore.currentTemplate directly from the local list
 *   5. On submit, sends CREATE_WORKFLOW → extension creates a working file, loads it, sends WORKFLOW_CREATED
 *   6. WORKFLOW_CREATED → useMessageHandler closes modal
 *
 * Features:
 * - Template dropdown (Built-in / Custom / Actions groups)
 * - Dynamic variable inputs based on selected template
 * - Filename input with validation
 * - Set as Default link
 * - Create and Create & Run buttons
 */
export const TemplateModal: React.FC<TemplateModalProps> = ({
  isOpen,
  onClose,
}) => {
  const canSelectWorkspacePath = useUiStore((state) =>
    state.hostCapabilities.includes(
      DASHBOARD_HOST_CAPABILITIES.selectWorkspacePath
    )
  );
  const vscode = useVsCodeApi();
  const filenameRef = useRef<HTMLInputElement>(null);
  // The form spans the same width as the header row, so measuring it tells
  // whether the title and a labelled scope toggle fit side by side.
  const [formRef, isNarrow] = useElementNarrow<HTMLFormElement>(
    TEMPLATE_MODAL_NARROW_PX
  );

  // Data from uiStore (populated by useMessageHandler on OPEN_NEW_WORKFLOW_MODAL)
  const templates = useUiStore((s) => s.templates);
  const openCreateTemplateForm = useUiStore((s) => s.openCreateTemplateForm);
  const defaultTemplateId = useUiStore((s) => s.defaultTemplateId);
  const defaultTemplateSource = useUiStore((s) => s.defaultTemplateSource);
  const defaultTemplateConfirmedId = useUiStore(
    (s) => s.defaultTemplateConfirmedId
  );
  const lastSavedTemplateScope = useUiStore((s) => s.lastSavedTemplateScope);
  const templateVariableDefaultsSaved = useUiStore(
    (s) => s.templateVariableDefaultsSaved
  );
  const setTemplateVariableDefaultsSaved = useUiStore(
    (s) => s.setTemplateVariableDefaultsSaved
  );
  const currentTemplate = useUiStore((s) => s.currentTemplate);
  const setCurrentTemplate = useUiStore((s) => s.setCurrentTemplate);
  const setDefaultTemplateId = useUiStore((s) => s.setDefaultTemplateId);
  const templateFileSelection = useUiStore((s) => s.templateFileSelection);
  const setTemplateFileSelection = useUiStore(
    (s) => s.setTemplateFileSelection
  );
  const customTemplateCreated = useUiStore((s) => s.customTemplateCreated);
  const setCustomTemplateCreated = useUiStore(
    (s) => s.setCustomTemplateCreated
  );
  const setTemplates = useUiStore((s) => s.setTemplates);
  const hiddenDropdownOptions = useUiStore((s) => s.hiddenDropdownOptions);
  const hideDropdownOption = useUiStore((s) => s.hideDropdownOption);
  const unhideDropdownOption = useUiStore((s) => s.unhideDropdownOption);
  const fileBrowserState = useUiStore((s) => s.fileBrowserState);
  const openFileBrowser = useUiStore((s) => s.openFileBrowser);
  const harnessStatus = useSettingsStore((s) => s.harnessStatus);
  const modelOptions = useSettingsStore((s) => s.modelOptions);
  const harnessDefaultModels = useSettingsStore(
    (s) => s.globalSettings.harnessDefaultModels
  );
  const workspaceRoot = useSettingsStore((s) => s.globalSettings.workspaceRoot);
  const hasWorkspace = Boolean(workspaceRoot?.trim());

  // Local form state
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [filename, setFilename] = useState("");
  const [filenameError, setFilenameError] = useState<string | null>(null);
  const [variableErrors, setVariableErrors] = useState<Record<string, string>>(
    {}
  );
  const [selectedScope, setSelectedScope] = useState<SettingWriteScope>(
    lastSavedTemplateScope
  );
  const saveScope = hasWorkspace ? selectedScope : SETTING_SCOPES.USER;
  const scopeOptions = useMemo(
    () =>
      [
        SETTING_SCOPE_OPTIONS[0],
        { ...SETTING_SCOPE_OPTIONS[1], disabled: !hasWorkspace },
      ] as const,
    [hasWorkspace]
  );

  // "New template..." inline accordion state
  const [showCreateTemplateForm, setShowCreateTemplateForm] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateNameError, setNewTemplateNameError] = useState<
    string | null
  >(null);
  const [newTemplateScope, setNewTemplateScope] =
    useState<TemplateScope>("workspace");
  const [newTemplateFormat, setNewTemplateFormat] =
    useState<WorkflowFileFormat>(WORKFLOW_FILE_FORMATS.YAML);
  const [isCreatingTemplate, setIsCreatingTemplate] = useState(false);

  // Initialize form state when modal opens
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      const requestedId = defaultTemplateId || TEMPLATE_IDS.BLANK;
      const template =
        templates.find((candidate) => candidate.id === requestedId) ??
        templates.find((candidate) => candidate.id === TEMPLATE_IDS.BLANK) ??
        templates[0] ??
        null;
      const initId = template?.id ?? "";
      setSelectedTemplateId(initId);
      setFilename("");
      setFilenameError(null);
      setVariableErrors({});
      setSelectedScope(lastSavedTemplateScope);
      setShowCreateTemplateForm(openCreateTemplateForm);
      setNewTemplateName("");
      setNewTemplateNameError(null);
      setNewTemplateScope("workspace");
      setNewTemplateFormat(WORKFLOW_FILE_FORMATS.YAML);
      setIsCreatingTemplate(false);

      // Sync currentTemplate to match the default selection and seed its defaults
      setVariables(seedVariableDefaults(template));
      setCurrentTemplate(template);
    }
    prevIsOpenRef.current = isOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, openCreateTemplateForm, lastSavedTemplateScope]);

  useEffect(() => {
    setSelectedScope(lastSavedTemplateScope);
  }, [lastSavedTemplateScope]);

  // A save refreshes the template catalog. Re-seed only the fields included in
  // that save so unrelated values the user has typed remain untouched.
  useEffect(() => {
    if (
      !templateVariableDefaultsSaved ||
      templateVariableDefaultsSaved.templateId !== selectedTemplateId ||
      currentTemplate?.id !== selectedTemplateId
    ) {
      return;
    }
    const savedNames = new Set(templateVariableDefaultsSaved.variableNames);
    const refreshedDefaults = seedVariableDefaults(currentTemplate);
    setVariableErrors({});
    setVariables((previous) => {
      const next = { ...previous };
      for (const name of savedNames) {
        if (refreshedDefaults[name] === undefined) delete next[name];
        else next[name] = refreshedDefaults[name];
      }
      return next;
    });
    setTemplateVariableDefaultsSaved(null);
  }, [
    templateVariableDefaultsSaved,
    selectedTemplateId,
    currentTemplate,
    setTemplateVariableDefaultsSaved,
  ]);

  // Focus filename input when modal opens
  useEffect(() => {
    if (isOpen && filenameRef.current) {
      setTimeout(() => filenameRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Apply a picked file/directory path to a variable field, auto-filling the
  // workflow filename when the variable declares autoFillFilename: true.
  // Shared by both the native OS picker (TEMPLATE_FILE_SELECTED, below) and
  // the web FileBrowserModal's onSelect (handleBrowseFile) so the two paths
  // can't drift.
  const applyPickedPath = useCallback(
    (variable: string, path: string) => {
      setVariables((prev) => ({ ...prev, [variable]: path }));
      if (isSatisfiedRequiredValue(path)) {
        setVariableErrors((previous) => {
          if (!previous[variable]) return previous;
          const next = { ...previous };
          delete next[variable];
          return next;
        });
      }

      const meta = currentTemplate?.variables?.find((v) => v.name === variable);
      if (meta?.autoFillFilename && !filename) {
        // Extract basename without extension: "path/to/my-spec.md" → "my-spec"
        const base = path.split(/[\\/]/).pop() ?? path;
        const withoutExt = base.replace(/\.[^.]+$/, "");
        if (withoutExt) {
          setFilename(withoutExt);
          setFilenameError(null);
        }
      }
    },
    [currentTemplate, filename]
  );

  // Consume file selection from OS picker (sent back via TEMPLATE_FILE_SELECTED)
  useEffect(() => {
    if (!templateFileSelection) return;
    const { variable, path } = templateFileSelection;
    applyPickedPath(variable, path);
    // Clear so the effect doesn't re-fire
    setTemplateFileSelection(null);
  }, [templateFileSelection, applyPickedPath, setTemplateFileSelection]);

  // Handle template selection change
  const handleTemplateChange = useCallback(
    (templateId: string) => {
      setSelectedTemplateId(templateId);

      // Update currentTemplate directly from the local list (no round-trip needed)
      const template = templates.find((t) => t.id === templateId) ?? null;
      setVariables(seedVariableDefaults(template));
      setVariableErrors({});
      setCurrentTemplate(template);
    },
    [templates, setCurrentTemplate]
  );

  // Toggle the inline "New template..." accordion
  const handleToggleCreateTemplateForm = useCallback(() => {
    setShowCreateTemplateForm((prev) => !prev);
    setNewTemplateName("");
    setNewTemplateNameError(null);
  }, []);

  // Submit the inline create-template form — fully webview-driven, no native VS Code UI
  // (see WorkflowSerializer.handleCreateCustomTemplate for why this matters for browser clients).
  const handleCreateTemplateSubmit = useCallback(() => {
    const error = validateSafeName(
      newTemplateName,
      "Template name is required"
    );
    if (error) {
      setNewTemplateNameError(error);
      return;
    }
    setNewTemplateNameError(null);
    setIsCreatingTemplate(true);
    vscode.postMessage({
      type: MESSAGE_TYPES.CREATE_CUSTOM_TEMPLATE,
      name: newTemplateName.trim(),
      scope: newTemplateScope,
      format: newTemplateFormat,
      baseTemplateId: selectedTemplateId,
    });
  }, [
    vscode,
    newTemplateName,
    newTemplateScope,
    newTemplateFormat,
    selectedTemplateId,
  ]);

  // Consume the result of CREATE_CUSTOM_TEMPLATE (sent back via CUSTOM_TEMPLATE_CREATED)
  useEffect(() => {
    if (!customTemplateCreated) return;
    setIsCreatingTemplate(false);

    if (customTemplateCreated.error) {
      setNewTemplateNameError(customTemplateCreated.error);
    } else {
      setTemplates(customTemplateCreated.templates);
      if (customTemplateCreated.templateId) {
        const created =
          customTemplateCreated.templates.find(
            (t) => t.id === customTemplateCreated.templateId
          ) ?? null;
        setSelectedTemplateId(customTemplateCreated.templateId);
        setVariables(seedVariableDefaults(created));
        setVariableErrors({});
        setCurrentTemplate(created);
      }
      setShowCreateTemplateForm(false);
      setNewTemplateName("");
      setNewTemplateNameError(null);
    }

    setCustomTemplateCreated(null);
  }, [
    customTemplateCreated,
    setTemplates,
    setCurrentTemplate,
    setCustomTemplateCreated,
  ]);

  const pairedModels = useMemo(
    () => modelVariablesByHarness(currentTemplate),
    [currentTemplate]
  );

  // Handle variable change. Changing a harness clears the models that follow
  // it; the effect below then picks the new harness's default model.
  const handleVariableChange = useCallback(
    (variable: string, value: string) => {
      if (isSatisfiedRequiredValue(value)) {
        setVariableErrors((previous) => {
          if (!previous[variable]) return previous;
          const next = { ...previous };
          delete next[variable];
          return next;
        });
      }
      setVariables((prev) => {
        const next = { ...prev, [variable]: value };
        if (prev[variable] !== value) {
          for (const model of pairedModels.get(variable) ?? []) {
            next[model.name] = "";
          }
        }
        return next;
      });
    },
    [pairedModels]
  );

  // Give every paired model without a value its harness's default model, as
  // soon as that harness's model list has loaded.
  useEffect(() => {
    setVariables((prev) => {
      let next = prev;
      for (const [harnessVariable, models] of pairedModels) {
        const harness = prev[harnessVariable] as HarnessId;
        const fallback = defaultModelForHarness(
          harness,
          harnessDefaultModels,
          modelOptions[harness] ?? []
        );
        if (fallback === undefined) continue;
        for (const model of models) {
          if (next[model.name]) continue;
          next = next === prev ? { ...prev } : next;
          next[model.name] = fallback;
        }
      }
      return next;
    });
  }, [variables, pairedModels, modelOptions, harnessDefaultModels]);

  // Open a file/directory picker for a file- or directory-type variable.
  // VS Code panel → native OS dialog (same machine as the extension host).
  // Hosted browser → the web-native FileBrowserModal, since a native dialog
  // would open invisibly on the host's screen (see MODAL_FILE_BROWSER_PLAN.md).
  const handleBrowseFile = useCallback(
    (variable: string, meta?: TemplateVariable) => {
      if (!canSelectWorkspacePath) {
        openFileBrowser({
          mode:
            meta?.type === WORKSPACE_ENTRY_KINDS.DIRECTORY
              ? WORKSPACE_ENTRY_KINDS.DIRECTORY
              : WORKSPACE_ENTRY_KINDS.FILE,
          fileFilter: meta?.fileFilter,
          onSelect: (path) => applyPickedPath(variable, path),
        });
        return;
      }
      vscode.postMessage({
        type: MESSAGE_TYPES.BROWSE_TEMPLATE_FILE,
        variable,
        fileFilter: meta?.fileFilter,
        selectFolder: meta?.type === WORKSPACE_ENTRY_KINDS.DIRECTORY,
      });
    },
    [vscode, openFileBrowser, applyPickedPath, canSelectWorkspacePath]
  );

  // Validate filename
  const validateFilename = useCallback((name: string): boolean => {
    const error = validateSafeName(name, "Workflow name is required");
    setFilenameError(error);
    return !error;
  }, []);

  const requiredVariables = useMemo(
    () =>
      (currentTemplate?.variables ?? []).filter(
        (variable) => variable.required
      ),
    [currentTemplate]
  );
  const hasUnsatisfiedRequired = useMemo(
    () =>
      requiredVariables.some(
        (variable) => !isSatisfiedRequiredValue(variables[variable.name])
      ),
    [requiredVariables, variables]
  );

  const validateRequiredVariable = useCallback(
    (name: string, value = variables[name] ?? "") => {
      const variable = requiredVariables.find(
        (candidate) => candidate.name === name
      );
      if (!variable) return true;
      const satisfied = isSatisfiedRequiredValue(value);
      setVariableErrors((previous) => {
        if (satisfied) {
          if (!previous[name]) return previous;
          const next = { ...previous };
          delete next[name];
          return next;
        }
        if (previous[name] === REQUIRED_VARIABLE_ERROR) return previous;
        return { ...previous, [name]: REQUIRED_VARIABLE_ERROR };
      });
      return satisfied;
    },
    [requiredVariables, variables]
  );

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
      scope: saveScope,
    });

    // Optimistic update
    setDefaultTemplateId(selectedTemplateId);
  }, [vscode, selectedTemplateId, saveScope, setDefaultTemplateId]);

  const handleSaveVariableDefaults = useCallback(
    (group: TemplateVariable[]) => {
      if (!selectedTemplateId || selectedTemplateId === "__create_new__")
        return;
      vscode.postMessage({
        type: MESSAGE_TYPES.SET_TEMPLATE_VARIABLE_DEFAULTS,
        templateId: selectedTemplateId,
        scope: saveScope,
        values: Object.fromEntries(
          group.map((variable) => [
            variable.name,
            variables[variable.name] ?? "",
          ])
        ),
      });
    },
    [selectedTemplateId, vscode, saveScope, variables]
  );

  const handleClearSavedVariableDefaults = useCallback(
    (group: TemplateVariable[], scope: SettingWriteScope) => {
      if (!selectedTemplateId || selectedTemplateId === "__create_new__")
        return;
      vscode.postMessage({
        type: MESSAGE_TYPES.SET_TEMPLATE_VARIABLE_DEFAULTS,
        templateId: selectedTemplateId,
        scope,
        values: Object.fromEntries(
          group.map((variable) => [variable.name, null])
        ),
      });
    },
    [selectedTemplateId, vscode]
  );

  // Submit workflow creation
  const handleSubmit = useCallback(
    (runAfter: boolean) => {
      const filenameIsValid = validateFilename(filename);
      let requiredVariablesAreValid = true;
      for (const variable of requiredVariables) {
        if (!validateRequiredVariable(variable.name)) {
          requiredVariablesAreValid = false;
        }
      }
      if (!filenameIsValid || !requiredVariablesAreValid) return;

      vscode.postMessage({
        type: MESSAGE_TYPES.CREATE_WORKFLOW,
        templateId: selectedTemplateId,
        variables,
        filename: filename.trim(),
        runAfter,
      });
    },
    [
      vscode,
      selectedTemplateId,
      variables,
      filename,
      validateFilename,
      requiredVariables,
      validateRequiredVariable,
    ]
  );

  // Keyboard handling
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === KEYBOARD_KEYS.ENTER) {
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
  const workspaceTemplates = templates.filter(
    (t) => !t.isBuiltIn && t.source !== TEMPLATE_SOURCES.USER
  );
  const userTemplates = templates.filter(
    (t) => !t.isBuiltIn && t.source === TEMPLATE_SOURCES.USER
  );

  // Set as Default acts on the picked template, so it sits on the Template
  // label row; once the picked template is the default, a marker replaces it.
  const renderDefaultTemplateControl = () => {
    if (!selectedTemplateId || selectedTemplateId === "__create_new__")
      return null;
    if (selectedTemplateId !== defaultTemplateId) {
      return (
        <LabelActionLink
          onClick={handleSetDefault}
          title="Set this as the default template"
        >
          Set as Default
        </LabelActionLink>
      );
    }
    const savedSource =
      defaultTemplateSource !== TEMPLATE_VARIABLE_DEFAULT_SOURCES.TEMPLATE &&
      defaultTemplateConfirmedId === selectedTemplateId
        ? defaultTemplateSource === TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE
          ? "Workspace"
          : "User"
        : null;
    return (
      <span className={LABEL_ACTION_NOTE_CLASS}>
        {savedSource ? `Default template (${savedSource})` : "Default template"}
      </span>
    );
  };

  const renderVariableDefaultControls = (
    group: TemplateVariable[],
    isMultiline: boolean
  ) => {
    if (isMultiline) return null;
    const source = group.find(
      (variable) =>
        variable.defaultSource === TEMPLATE_VARIABLE_DEFAULT_SOURCES.USER ||
        variable.defaultSource === TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE
    )?.defaultSource;
    const savedScope =
      source === TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE
        ? SETTING_SCOPES.WORKSPACE
        : source === TEMPLATE_VARIABLE_DEFAULT_SOURCES.USER
          ? SETTING_SCOPES.USER
          : null;
    const differsFromDefault = group.some(
      (variable) => variables[variable.name] !== variable.default
    );
    if (!savedScope && !differsFromDefault) return null;
    const scopeLabel =
      savedScope === SETTING_SCOPES.WORKSPACE ? "Workspace" : "User";
    return (
      <span className="inline-flex items-center gap-2">
        {savedScope && (
          <span className={LABEL_ACTION_NOTE_CLASS}>Saved ({scopeLabel})</span>
        )}
        <LabelActionLink
          onClick={() =>
            savedScope
              ? handleClearSavedVariableDefaults(group, savedScope)
              : handleSaveVariableDefaults(group)
          }
          title={
            savedScope
              ? `Clear saved value from ${scopeLabel} settings`
              : `Save ${group.length > 1 ? "these values" : "this value"} as the variable default in ${saveScope === SETTING_SCOPES.WORKSPACE ? "Workspace" : "User"} settings`
          }
        >
          {savedScope ? "Clear saved value" : "Save as default"}
        </LabelActionLink>
      </span>
    );
  };

  return (
    <Modal
      isOpen={isOpen && !fileBrowserState}
      onClose={onClose}
      title="Create Workflow from Template"
      size="lg"
      wrapTitle
      headerActions={
        <ScopeToggle
          ariaLabel="Save defaults to"
          value={saveScope}
          onChange={setSelectedScope}
          options={scopeOptions}
          iconOnly={isNarrow}
        />
      }
      footer={
        <div className="flex items-center justify-end w-full">
          <div className="flex items-center gap-2 whitespace-nowrap">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => handleSubmit(false)}
              disabled={
                !filename.trim() || !!filenameError || hasUnsatisfiedRequired
              }
            >
              Create
            </Button>
            <Button
              variant="primary"
              onClick={() => handleSubmit(true)}
              disabled={
                !filename.trim() || !!filenameError || hasUnsatisfiedRequired
              }
            >
              Create & Run
            </Button>
          </div>
        </div>
      }
    >
      <form
        ref={formRef}
        className="space-y-4"
        onSubmit={(e) => e.preventDefault()}
      >
        {/* Template Selection */}
        <div className="form-group">
          <FieldLabelRow
            htmlFor="template-select"
            labelClassName="text-sm font-medium text-foreground"
            action={renderDefaultTemplateControl()}
          >
            Template
          </FieldLabelRow>
          <select
            id="template-select"
            value={selectedTemplateId}
            onChange={(e) => handleTemplateChange(e.target.value)}
            className="w-full px-2 py-1.5 rounded-sm bg-dropdown-bg text-dropdown-fg border border-dropdown-border focus:outline-hidden focus:border-focus-border"
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

            {workspaceTemplates.length > 0 && (
              <optgroup label="Custom Templates (Workspace)">
                {workspaceTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </optgroup>
            )}

            {userTemplates.length > 0 && (
              <optgroup label="Custom Templates (User)">
                {userTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            type="button"
            onClick={handleToggleCreateTemplateForm}
            className="mt-1.5 group flex items-center gap-1 text-sm text-link-fg cursor-pointer w-fit bg-transparent border-0 p-0 font-inherit"
          >
            <Icon
              name={
                showCreateTemplateForm ? "codicon-chevron-down" : "codicon-add"
              }
            />
            <span className="group-hover:underline">New template...</span>
          </button>

          <AnimatedSection visible={showCreateTemplateForm} className="mt-2">
            <div className="space-y-2 p-3 rounded-sm border border-panel-border bg-panel-bg">
              <div className="form-group">
                <label
                  htmlFor="new-template-name"
                  className="block text-sm text-foreground"
                >
                  <span className="block mb-1">Template Name</span>
                  <input
                    type="text"
                    id="new-template-name"
                    aria-label="Template Name"
                    value={newTemplateName}
                    onChange={(e) => {
                      setNewTemplateName(e.target.value);
                      if (newTemplateNameError) setNewTemplateNameError(null);
                    }}
                    placeholder="my-custom-template"
                    className={`w-full px-2 py-1.5 rounded-sm bg-input-bg text-input-fg border focus:outline-hidden ${
                      newTemplateNameError
                        ? "border-input-error-border"
                        : "border-input-border focus:border-focus-border"
                    }`}
                  />
                </label>
                {newTemplateNameError && (
                  <p className="mt-1 text-xs text-error-fg">
                    {newTemplateNameError}
                  </p>
                )}
              </div>

              <p className="text-xs text-description-fg">
                Starts from {currentTemplate?.name ?? "the selected template"}.
                Its workflow structure, metadata, and variables will be copied.
              </p>

              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground">Location</span>
                <ScopeToggle
                  ariaLabel="Template location"
                  value={newTemplateScope}
                  onChange={setNewTemplateScope}
                  options={TEMPLATE_SCOPE_OPTIONS}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground">Format</span>
                <ScopeToggle
                  ariaLabel="Template format"
                  value={newTemplateFormat}
                  onChange={setNewTemplateFormat}
                  options={TEMPLATE_FORMAT_OPTIONS}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  variant="secondary"
                  onClick={handleToggleCreateTemplateForm}
                  disabled={isCreatingTemplate}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleCreateTemplateSubmit}
                  disabled={isCreatingTemplate || !newTemplateName.trim()}
                >
                  {isCreatingTemplate ? "Creating…" : "Create Template"}
                </Button>
              </div>
            </div>
          </AnimatedSection>
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
            {currentTemplate.variables.map((variable) => {
              // A paired model renders beside its harness, not in order.
              if (
                variable.type === TEMPLATE_VARIABLE_TYPES.MODEL &&
                variable.harness
              )
                return null;
              const isHarness =
                variable.type === TEMPLATE_VARIABLE_TYPES.HARNESS;
              const models = isHarness
                ? pairedModels.get(variable.name)
                : undefined;
              const paired = models ?? [];
              const isMultiline =
                !!variable.multiline &&
                variable.type !== WORKSPACE_ENTRY_KINDS.FILE &&
                variable.type !== WORKSPACE_ENTRY_KINDS.DIRECTORY &&
                variable.type !== TEMPLATE_VARIABLE_TYPES.SELECT &&
                !isHarness;
              return (
                <div key={variable.name}>
                  <TemplateVariableField
                    variable={variable}
                    value={variables[variable.name] ?? ""}
                    values={variables}
                    onChange={handleVariableChange}
                    error={variableErrors[variable.name]}
                    pairedModelErrors={Object.fromEntries(
                      paired.map((model) => [
                        model.name,
                        variableErrors[model.name],
                      ])
                    )}
                    onBlur={validateRequiredVariable}
                    pairedModels={paired}
                    modelOptions={modelOptions}
                    harnessStatus={harnessStatus}
                    hiddenDropdownOptions={hiddenDropdownOptions}
                    onHideOption={hideDropdownOption}
                    onUnhideOption={unhideDropdownOption}
                    onBrowse={(selected) =>
                      handleBrowseFile(selected.name, selected)
                    }
                    multiline={isMultiline}
                    onKeyDown={handleKeyDown}
                    labelAction={renderVariableDefaultControls(
                      models?.length ? [variable, ...models] : [variable],
                      isMultiline
                    )}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Workflow Name / Filename */}
        <div className="form-group">
          <label
            htmlFor="workflow-name"
            className="block text-sm font-medium text-foreground"
          >
            <span className="block mb-1">Workflow Name</span>
            <input
              ref={filenameRef}
              type="text"
              aria-label="Workflow Name"
              id="workflow-name"
              value={filename}
              onChange={(e) => handleFilenameChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="my-workflow"
              className={`w-full px-2 py-1.5 rounded-sm bg-input-bg text-input-fg border focus:outline-hidden ${
                filenameError
                  ? "border-input-error-border"
                  : "border-input-border focus:border-focus-border"
              }`}
            />
          </label>
          {filenameError && (
            <p className="mt-1 text-xs text-error-fg">{filenameError}</p>
          )}
        </div>
      </form>
    </Modal>
  );
};
