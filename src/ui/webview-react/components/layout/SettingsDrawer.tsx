import React, { useState, useCallback, useEffect } from "react";
import {
  useSettingsStore,
  type WorkflowProperties,
} from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { MESSAGE_TYPES, EXECUTION_MODES, type PriorContext } from "../../types/messages";
import {
  DROPDOWN_NAMESPACES,
  modelNamespaceForHarness,
  getResumeSessionOptions,
} from "../../types/dropdownNamespaces";
import {
  PanelBar,
  IconToggleButton,
  CustomSelect,
  MultiCheckboxDropdown,
  HarnessDropdown,
  harnessCategory,
  PriorContextSelect,
} from "../shared";

const BUTTON_STATE = { IDLE: "idle", SUCCESS: "success", FADING: "fading" } as const;
type ButtonState = (typeof BUTTON_STATE)[keyof typeof BUTTON_STATE];

/**
 * Set as Default link with animation
 */
const SetAsDefaultButton: React.FC<{
  property: string;
  show: boolean;
  onSetDefault: () => void;
}> = ({ show, onSetDefault }) => {
  const [state, setState] = useState<ButtonState>(BUTTON_STATE.IDLE);

  const handleClick = useCallback(() => {
    onSetDefault();
    setState(BUTTON_STATE.SUCCESS);
    setTimeout(() => setState(BUTTON_STATE.FADING), 2000);
    setTimeout(() => setState(BUTTON_STATE.IDLE), 2300);
  }, [onSetDefault]);

  if (!show && state === BUTTON_STATE.IDLE) return null;

  return (
    <a
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && handleClick()}
      className={`text-[10px] font-semibold uppercase text-link-fg hover:underline cursor-pointer transition-colors ${
        state === BUTTON_STATE.SUCCESS ? "text-green-500" : ""
      } ${state === BUTTON_STATE.FADING ? "opacity-0" : ""}`}
      title="Set this as the default for new workflows"
    >
      {state === BUTTON_STATE.SUCCESS ? "✓ Default" : "Set as Default"}
    </a>
  );
};

/**
 * Form field wrapper with label and description
 */
const FormField: React.FC<{
  label: string;
  description?: string;
  htmlFor?: string;
  children: React.ReactNode;
  setAsDefaultButton?: React.ReactNode;
}> = ({ label, description, htmlFor, children, setAsDefaultButton }) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center justify-between min-h-[18px]">
      <label
        htmlFor={htmlFor}
        title={description}
        className="text-[11px] font-semibold uppercase text-description-fg cursor-help"
      >
        {label}
      </label>
      {setAsDefaultButton}
    </div>
    {children}
  </div>
);

/**
 * Layout row: 2-column grid in wide mode, transparent fragment in narrow mode
 * so the parent's space-y-4 controls spacing uniformly.
 */
const Row: React.FC<{ narrow: boolean; children: React.ReactNode }> = ({
  narrow,
  children,
}) =>
  narrow ? (
    <>{children}</>
  ) : (
    <div className="grid grid-cols-2 gap-4">{children}</div>
  );

/**
 * SettingsPanel Component
 *
 * Collapsible panel for configuring:
 * - Harness settings (harness, model, agent)
 * - Workflow properties (execution mode, resume session, dynamic queue)
 * - End condition configuration
 * - Quick access to VS Code settings
 */
export const SettingsPanel: React.FC<{
  panelBarOrientation?: "horizontal" | "vertical";
}> = ({ panelBarOrientation = "vertical" }) => {
  const vscode = useVsCodeApi();
  const {
    settingsCollapsed,
    toggleSettingsCollapse,
    hiddenDropdownOptions,
    hideDropdownOption,
    unhideDropdownOption,
    loadedWorkflows,
    activeWorkflowId,
  } = useUiStore();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy === "cli";
  const {
    availableAgents,
    availableSkills,
    harnessStatus: harnessStatus,
    globalSettings,
    workflowProperties,
    getModelsForHarness: getModelsForHarness,
    getEffectiveHarness: getEffectiveHarness,
    getEffectiveModel,
    getEffectiveAgent,
    getEffectiveSkills,
    getEffectiveResumeSession,
    getEffectiveAllowDynamicExtension,
    getEffectivePriorContext,
  } = useSettingsStore();
  const prompts = useWorkflowStore((s) => s.prompts);

  // End condition enabled state
  const [endConditionEnabled, setEndConditionEnabled] = useState(
    workflowProperties.endCondition !== null &&
      workflowProperties.endCondition !== undefined
  );

  // Session ID input state
  const [sessionIdInput, setSessionIdInput] = useState("");

  // Sync sessionIdInput with store changes
  useEffect(() => {
    const sessionId = workflowProperties.sessionId;
    setSessionIdInput(sessionId !== undefined ? String(sessionId) : "");
  }, [workflowProperties.sessionId]);

  // Update end condition state when workflow properties change
  useEffect(() => {
    setEndConditionEnabled(
      workflowProperties.endCondition !== null &&
        workflowProperties.endCondition !== undefined
    );
  }, [workflowProperties.endCondition]);

  // Narrow detection for footer toggle buttons
  const [footerRef, isFooterNarrow] = useElementNarrow<HTMLDivElement>(300);

  // Wide detection for 2-column body layout (matches PropertiesDrawer breakpoint)
  const [bodyRef, isBodyNarrow] = useElementNarrow<HTMLDivElement>(440);

  // Get current effective values
  const effectiveHarness = getEffectiveHarness();
  const effectiveModel = getEffectiveModel();
  const effectiveAgent = getEffectiveAgent();
  const effectiveSkills = getEffectiveSkills();
  const effectiveResumeSession = getEffectiveResumeSession();
  const effectiveAllowDynamicExtension = getEffectiveAllowDynamicExtension();
  const effectivePriorContext = getEffectivePriorContext();

  // Derive the active model namespace from the current harness
  const modelNamespace = modelNamespaceForHarness(effectiveHarness);

  // Get models for current harness
  const currentHarnessModels = getModelsForHarness(effectiveHarness);

  // Check if workflow value differs from global setting
  const isDifferentFromGlobal = useCallback(
    (property: keyof WorkflowProperties) => {
      const workflowValue = workflowProperties[property];
      if (workflowValue === undefined) return false;
      if (property === "model") {
        // Compare against the global default for the effective harness, not the
        // global harness default — they differ when a non-default harness is selected
        return (
          workflowValue !==
          globalSettings.harnessDefaultModels[effectiveHarness]
        );
      }
      if (property === "additionalArgs") {
        // Compare against the harness-specific default, treating empty string,
        // null, and undefined as equivalent — all mean "no args"
        const harnessDefault =
          globalSettings.harnessDefaultAdditionalArgs[effectiveHarness] ?? "";
        return (workflowValue || "") !== (harnessDefault || "");
      }
      // Array comparison for skills — compare against global default skills
      if (property === "skills") {
        return (
          JSON.stringify(workflowValue) !==
          JSON.stringify(globalSettings.skills ?? [])
        );
      }
      // JSON comparison for priorContext — value can be a string or number[]
      if (property === "priorContext") {
        return (
          JSON.stringify(workflowValue) !==
          JSON.stringify(globalSettings.priorContext)
        );
      }
      const globalValue =
        globalSettings[property as keyof typeof globalSettings];
      return workflowValue !== globalValue;
    },
    [workflowProperties, globalSettings, effectiveHarness]
  );

  const postWorkflowPropertiesUpdate = useCallback(
    (updates: Partial<WorkflowProperties>) => {
      const settingsStore = useSettingsStore.getState();

      for (const [property, value] of Object.entries(updates)) {
        settingsStore.updateWorkflowProperty(
          property as keyof WorkflowProperties,
          value as WorkflowProperties[keyof WorkflowProperties]
        );
      }

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTIES,
        properties: updates,
      });
    },
    [vscode]
  );

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const handleHarnessChange = useCallback(
    (harness: string) => {
      const settingsStore = useSettingsStore.getState();

      // Update model dropdown options for new harness (like old implementation)
      // Get models for the new harness
      const newHarnessModels = getModelsForHarness(harness as any);
      const updates: Partial<WorkflowProperties> = { harness };

      // Always update model to the global default for the new harness
      if (newHarnessModels.length > 0) {
        const globalDefaultForHarness =
          settingsStore.globalSettings.harnessDefaultModels[harness];
        const isGlobalDefaultValid = newHarnessModels.some(
          (m) => m.value === globalDefaultForHarness
        );
        const defaultModel = isGlobalDefaultValid
          ? globalDefaultForHarness
          : newHarnessModels[0].value;

        updates.model = defaultModel;
      }

      // Always update additionalArgs to the global default for the new harness.
      // Use the empty string directly (not undefined) so JSON serialization
      // preserves the value and the extension receives the clear instruction.
      const globalDefaultAdditionalArgs =
        settingsStore.globalSettings.harnessDefaultAdditionalArgs[harness] ??
        "";
      updates.additionalArgs = globalDefaultAdditionalArgs;

      postWorkflowPropertiesUpdate(updates);
    },
    [getModelsForHarness, postWorkflowPropertiesUpdate]
  );

  const handleModelChange = useCallback(
    (model: string) => {
      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("model", model);

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "model",
        value: model,
      });
    },
    [vscode]
  );

  const handleAgentChange = useCallback(
    (agent: string) => {
      // Optimistic update — store raw value (including "" for explicit "None")
      // so that getEffectiveAgent() can distinguish "no override" (undefined)
      // from "explicitly set to None" (""), which allows clearing a global default.
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("agent", agent);

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "agent",
        value: agent,
      });
    },
    [vscode]
  );

  const handleSkillsChange = useCallback(
    (skills: string[]) => {
      // Optimistic update — store raw array (including [] for explicit "None")
      // so that getEffectiveSkills() can distinguish "no override" (undefined)
      // from "explicitly cleared" ([]), which allows clearing a global default.
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("skills", skills);

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "skills",
        value: skills,
      });
    },
    [vscode]
  );

  const handleExecutionModeChange = useCallback(
    (mode: string) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.CHANGE_EXECUTION_MODE,
        executionMode: mode,
      });
    },
    [vscode]
  );

  const handleResumeSessionChange = useCallback(
    (checked: boolean) => {
      const updates: Partial<WorkflowProperties> = {
        resumeSession: checked,
      };

      // Clear session ID when resume is disabled
      if (!checked) {
        setSessionIdInput("");
        updates.sessionId = undefined;
      }

      postWorkflowPropertiesUpdate(updates);
    },
    [postWorkflowPropertiesUpdate]
  );

  const handleSessionIdChange = useCallback(
    (value: string) => {
      setSessionIdInput(value);
      // Parse as number if valid integer, otherwise keep as string
      const parsedValue = /^\d+$/.test(value.trim())
        ? parseInt(value.trim(), 10)
        : value.trim() || undefined;

      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("sessionId", parsedValue);

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "sessionId",
        value: parsedValue,
      });
    },
    [vscode]
  );

  const handleDynamicExtensionChange = useCallback(
    (checked: boolean) => {
      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("allowDynamicExtension", checked);

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "allowDynamicExtension",
        value: checked,
      });
    },
    [vscode]
  );

  const handleAdditionalArgsChange = useCallback(
    (value: string) => {
      const settingsStore = useSettingsStore.getState();
      // Store the empty string explicitly (not undefined) so the extension
      // receives the update and "Set as Default" can appear when the field
      // is cleared while a non-empty VS Code default exists.
      settingsStore.updateWorkflowProperty("additionalArgs", value);

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "additionalArgs",
        value: value,
      });
    },
    [vscode]
  );

  const handlePriorContextChange = useCallback(
    (value: PriorContext | undefined) => {
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("priorContext", value);

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "priorContext",
        value: value,
      });
    },
    [vscode]
  );

  const handleEndConditionToggle = useCallback(
    (enabled: boolean) => {
      setEndConditionEnabled(enabled);

      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      if (!enabled) {
        settingsStore.updateWorkflowProperty("endCondition", undefined);
        vscode.postMessage({
          type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
          property: "endCondition",
          value: undefined,
        });
      } else {
        // Initialize with defaults
        const defaultEndCondition = {
          script: "",
          returns: "true",
          timeout: 30000,
          maxRetries: 0,
          retryPrompt: "",
        };
        settingsStore.updateWorkflowProperty(
          "endCondition",
          defaultEndCondition
        );
        vscode.postMessage({
          type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
          property: "endCondition",
          value: defaultEndCondition,
        });
      }
    },
    [vscode]
  );

  const handleEndConditionFieldChange = useCallback(
    (field: string, value: string | number | boolean) => {
      const currentEndCondition = workflowProperties.endCondition || {};
      const updatedEndCondition = {
        ...currentEndCondition,
        [field]: value,
      };

      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("endCondition", updatedEndCondition);

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "endCondition",
        value: updatedEndCondition,
      });
    },
    [vscode, workflowProperties.endCondition]
  );

  const handleSetAsDefault = useCallback(
    (property: string, value: unknown, harness?: string) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.SET_AS_DEFAULT,
        property,
        value,
        harness:
          harness ?? (property === "model" ? effectiveHarness : undefined),
      });
    },
    [vscode, effectiveHarness]
  );

  const handleRespectGitignoreChange = useCallback(
    (checked: boolean) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_CONFIG,
        key: "flightpath.respectGitignoreForCompletions",
        value: checked,
      });
    },
    [vscode]
  );

  const handleOpenSettings = useCallback(() => {
    vscode.postMessage({
      type: MESSAGE_TYPES.OPEN_SETTINGS,
    });
  }, [vscode]);

  // ============================================================================
  // RENDER
  // ============================================================================

  if (settingsCollapsed) {
    return (
      <PanelBar
        orientation={panelBarOrientation}
        icon="settings-gear"
        title="Workflow Properties"
        onClick={toggleSettingsCollapse}
      />
    );
  }

  const endCondition = workflowProperties.endCondition || {};

  return (
    <div className="flex flex-col h-full bg-sidebar-bg">
      {/* Section Header - clickable to collapse */}
      <div
        className="flex items-center justify-between h-[30px] px-2 border-b border-panel-border cursor-pointer select-none"
        onClick={toggleSettingsCollapse}
        role="button"
        aria-label="Collapse workflow properties"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && toggleSettingsCollapse()}
      >
        <div className="flex items-center gap-1 text-description-fg hover:text-foreground transition-colors">
          <i className="codicon codicon-chevron-right text-[12px] rotate-90 transition-transform duration-150" />
          <i className="codicon codicon-settings-gear text-[14px]" />
          <span className="text-[11px] font-semibold uppercase tracking-wide ml-0.5">
            Workflow Properties
          </span>
        </div>
      </div>

      {/* Body - Scrollable (pointer-events disabled in CLI watch mode) */}
      <div
        ref={bodyRef}
        className={`flex-1 overflow-y-auto${isCLIManaged ? " pointer-events-none opacity-60 select-none" : ""}`}
      >
        <div className="px-4 py-2 space-y-2">
          {/* Row 1: Harness + Model */}
          <Row narrow={isBodyNarrow}>
            <FormField
              label={`Harness${harnessCategory(effectiveHarness) === "cli" ? " (CLI)" : harnessCategory(effectiveHarness) === "chat" ? " (Chat)" : ""}`}
              htmlFor="settings-harness"
              description="AI harness for execution"
              setAsDefaultButton={
                <SetAsDefaultButton
                  property="harness"
                  show={isDifferentFromGlobal("harness")}
                  onSetDefault={() =>
                    handleSetAsDefault("harness", workflowProperties.harness)
                  }
                />
              }
            >
              <HarnessDropdown
                id="settings-harness"
                value={effectiveHarness}
                onChange={handleHarnessChange}
                harnessStatus={harnessStatus}
                hiddenValues={
                  hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? []
                }
                onHideOption={(v) =>
                  hideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)
                }
                onUnhideOption={(v) =>
                  unhideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)
                }
              />
            </FormField>

            <FormField
              label="Model"
              htmlFor="settings-model"
              description="AI model for execution"
              setAsDefaultButton={
                <SetAsDefaultButton
                  property="model"
                  show={isDifferentFromGlobal("model")}
                  onSetDefault={() =>
                    handleSetAsDefault("model", workflowProperties.model)
                  }
                />
              }
            >
              <CustomSelect
                id="settings-model"
                value={effectiveModel}
                onChange={handleModelChange}
                options={
                  currentHarnessModels.length === 0
                    ? [
                        {
                          value: "",
                          label: "Loading models...",
                          disabled: true,
                        },
                      ]
                    : currentHarnessModels.map((m) => ({
                        value: m.value,
                        label: m.label,
                      }))
                }
                namespace={modelNamespace}
                hiddenValues={hiddenDropdownOptions[modelNamespace] ?? []}
                onHideOption={(v) => hideDropdownOption(modelNamespace, v)}
                onUnhideOption={(v) => unhideDropdownOption(modelNamespace, v)}
                nonHideableValues={["default", ""]}
              />
            </FormField>
          </Row>

          {/* Row 2: Agent + Skills */}
          <Row narrow={isBodyNarrow}>
            <FormField
              label="Agent"
              htmlFor="settings-agent"
              description="Custom agent file (.agent.md)"
              setAsDefaultButton={
                <SetAsDefaultButton
                  property="agent"
                  show={isDifferentFromGlobal("agent")}
                  onSetDefault={() =>
                    handleSetAsDefault("agent", workflowProperties.agent)
                  }
                />
              }
            >
              <CustomSelect
                id="settings-agent"
                value={effectiveAgent || ""}
                onChange={handleAgentChange}
                options={[
                  { value: "", label: "None (default behavior)" },
                  ...availableAgents.map((agent) => ({
                    value: agent.name || agent.path,
                    label: `${agent.name || "Unknown Agent"}${agent.description ? ` - ${agent.description}` : ""}`,
                  })),
                ]}
                namespace={DROPDOWN_NAMESPACES.AGENT}
                hiddenValues={
                  hiddenDropdownOptions[DROPDOWN_NAMESPACES.AGENT] ?? []
                }
                onHideOption={(v) =>
                  hideDropdownOption(DROPDOWN_NAMESPACES.AGENT, v)
                }
                onUnhideOption={(v) =>
                  unhideDropdownOption(DROPDOWN_NAMESPACES.AGENT, v)
                }
                nonHideableValues={[]}
              />
            </FormField>

            <FormField
              label="Skills"
              htmlFor="settings-skills"
              description="Attach skills (frontmatter only, progressive disclosure)"
              setAsDefaultButton={
                <SetAsDefaultButton
                  property="skills"
                  show={isDifferentFromGlobal("skills")}
                  onSetDefault={() =>
                    handleSetAsDefault("skills", workflowProperties.skills)
                  }
                />
              }
            >
              <MultiCheckboxDropdown
                id="settings-skills"
                selectedValues={effectiveSkills}
                onChange={handleSkillsChange}
                options={availableSkills.map((s) => ({
                  value: s.name,
                  label: s.name,
                  description: s.description || undefined,
                }))}
                placeholder="No skills selected"
                namespace={DROPDOWN_NAMESPACES.SKILLS}
                hiddenValues={
                  hiddenDropdownOptions[DROPDOWN_NAMESPACES.SKILLS] ?? []
                }
                onHideOption={(v) =>
                  hideDropdownOption(DROPDOWN_NAMESPACES.SKILLS, v)
                }
                onUnhideOption={(v) =>
                  unhideDropdownOption(DROPDOWN_NAMESPACES.SKILLS, v)
                }
              />
              {effectiveSkills.length > 0 && (
                <p className="text-[10px] text-description-fg mt-0.5">
                  Active: {effectiveSkills.join(", ")}
                </p>
              )}
            </FormField>
          </Row>

          {/* Row 3: Additional Args + Resume Session (with paired Session ID) */}
          <Row narrow={isBodyNarrow}>
            <FormField
              label="Additional Args"
              htmlFor="settings-append-args"
              description="Extra CLI flags appended to FlightPath's standard argument set. Only applies to CLI harnesses."
              setAsDefaultButton={
                <SetAsDefaultButton
                  property="additionalArgs"
                  show={isDifferentFromGlobal("additionalArgs")}
                  onSetDefault={() =>
                    handleSetAsDefault(
                      "additionalArgs",
                      workflowProperties.additionalArgs,
                      effectiveHarness
                    )
                  }
                />
              }
            >
              <input
                type="text"
                id="settings-append-args"
                value={workflowProperties.additionalArgs ?? ""}
                onChange={(e) => handleAdditionalArgsChange(e.target.value)}
                placeholder="e.g. --effort high --max-turns 10"
                className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono h-7"
              />
            </FormField>

            <FormField
              label="Resume Session"
              htmlFor="settings-resume-session"
              description="Resume Session continues existing session. Session ID below resumes a specific session or reuses another prompt's session (by number)."
              setAsDefaultButton={
                <SetAsDefaultButton
                  property="resumeSession"
                  show={isDifferentFromGlobal("resumeSession")}
                  onSetDefault={() =>
                    handleSetAsDefault(
                      "resumeSession",
                      workflowProperties.resumeSession
                    )
                  }
                />
              }
            >
              <CustomSelect
                id="settings-resume-session"
                value={effectiveResumeSession ? "yes" : "no"}
                onChange={(v) => handleResumeSessionChange(v === "yes")}
                options={[...getResumeSessionOptions()]}
              />
              {/* Session ID input — visible only when resume session is enabled */}
              <div
                className={`transition-all duration-300 ${
                  effectiveResumeSession
                    ? "max-h-[40px] opacity-100 mt-1"
                    : "max-h-0 opacity-0 overflow-hidden"
                }`}
              >
                <input
                  type="text"
                  id="settings-session-id"
                  value={sessionIdInput}
                  onChange={(e) => handleSessionIdChange(e.target.value)}
                  placeholder="Enter session ID or prompt number"
                  className="w-full px-2 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border h-7"
                  title="Enter session ID (UUID) or prompt number (e.g., 1, 2, 3)"
                />
              </div>
            </FormField>
          </Row>

          {/* Row 4: Prior Context + Allow Dynamic Extension */}
          <Row narrow={isBodyNarrow}>
            <FormField
              label="Prior Context"
              htmlFor="settings-prior-context"
              description="Inject prior prompt outputs into each prompt's text before sending to the AI"
              setAsDefaultButton={
                <SetAsDefaultButton
                  property="priorContext"
                  show={isDifferentFromGlobal("priorContext")}
                  onSetDefault={() =>
                    handleSetAsDefault(
                      "priorContext",
                      workflowProperties.priorContext
                    )
                  }
                />
              }
            >
              <PriorContextSelect
                id="settings-prior-context"
                value={effectivePriorContext}
                onChange={handlePriorContextChange}
                priorPrompts={prompts.map((p, i) => ({
                  number: i + 1,
                  name: p.name,
                }))}
              />
            </FormField>

            <FormField
              label="Allow Dynamic Extension"
              htmlFor="settings-dynamic-ext"
              description="Allow harness to extend the workflow queue. This will add FlightPath's MCP configuration to the harness, which exposes functions for extending and querying the workflow queue."
              setAsDefaultButton={
                <SetAsDefaultButton
                  property="allowDynamicExtension"
                  show={isDifferentFromGlobal("allowDynamicExtension")}
                  onSetDefault={() =>
                    handleSetAsDefault(
                      "allowDynamicExtension",
                      workflowProperties.allowDynamicExtension
                    )
                  }
                />
              }
            >
              <CustomSelect
                id="settings-dynamic-ext"
                value={effectiveAllowDynamicExtension ? "yes" : "no"}
                onChange={(v) => handleDynamicExtensionChange(v === "yes")}
                options={[
                  { value: "no", label: "No - Disable" },
                  { value: "yes", label: "Yes - Allow AI to extend" },
                ]}
              />
            </FormField>
          </Row>

          {/* End Condition Section */}
          {/* Enable checkbox */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="settings-end-condition-enabled"
              checked={endConditionEnabled}
              onChange={(e) => handleEndConditionToggle(e.target.checked)}
              className="w-4 h-4 accent-focus-border cursor-pointer mt-1"
            />
            <label
              htmlFor="settings-end-condition-enabled"
              className="text-[11px] font-semibold uppercase text-description-fg cursor-pointer"
              title="Validation runs after each prompt completes. Individual prompts can override or disable this."
            >
              Global End Condition
            </label>
          </div>

          {/* End condition fields */}
          <div
            className={`space-y-3 transition-all duration-300 ${
              endConditionEnabled
                ? "max-h-[500px] opacity-100"
                : "max-h-0 opacity-0 overflow-hidden"
            }`}
          >
            {/* Row 1: Script + Returns */}
            <Row narrow={isBodyNarrow}>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="settings-end-script"
                  className="text-[11px] font-semibold text-description-fg"
                >
                  Script:
                </label>
                <input
                  type="text"
                  id="settings-end-script"
                  value={(endCondition as any).script || ""}
                  onChange={(e) =>
                    handleEndConditionFieldChange("script", e.target.value)
                  }
                  placeholder="npm test"
                  className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="settings-end-returns"
                  className="text-[11px] font-semibold text-description-fg"
                >
                  Returns:
                </label>
                <input
                  type="text"
                  id="settings-end-returns"
                  value={(endCondition as any).returns || ""}
                  onChange={(e) =>
                    handleEndConditionFieldChange("returns", e.target.value)
                  }
                  placeholder="true"
                  className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                />
              </div>
            </Row>

            {/* Row 2: Timeout + Max Retries */}
            <Row narrow={isBodyNarrow}>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="settings-end-timeout"
                  className="text-[11px] font-semibold text-description-fg"
                >
                  Timeout (ms):
                </label>
                <input
                  type="number"
                  id="settings-end-timeout"
                  value={(endCondition as any).timeout || 30000}
                  onChange={(e) =>
                    handleEndConditionFieldChange(
                      "timeout",
                      parseInt(e.target.value) || 30000
                    )
                  }
                  min={1000}
                  className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="settings-end-retries"
                  className="text-[11px] font-semibold text-description-fg"
                >
                  Max Retries:
                </label>
                <input
                  type="number"
                  id="settings-end-retries"
                  value={(endCondition as any).maxRetries ?? 0}
                  onChange={(e) =>
                    handleEndConditionFieldChange(
                      "maxRetries",
                      parseInt(e.target.value) ?? 0
                    )
                  }
                  min={-1}
                  className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                />
              </div>
            </Row>

            {/* Retry Prompt (full width) */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="settings-end-retry-prompt"
                className="text-[11px] font-semibold text-description-fg"
              >
                Retry Prompt:
              </label>
              <textarea
                id="settings-end-retry-prompt"
                value={(endCondition as any).retryPrompt || ""}
                onChange={(e) =>
                  handleEndConditionFieldChange("retryPrompt", e.target.value)
                }
                rows={3}
                placeholder={
                  "Validation failed: {error}\n\nPlease fix the issues."
                }
                className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border resize-none"
              />
            </div>

            {/* Resume Session on Retry (full width) */}
            <div className="flex items-center gap-2 mt-1">
              <input
                type="checkbox"
                id="settings-end-resume-session-on-retry"
                checked={(endCondition as any).resumeSessionOnRetry ?? true}
                onChange={(e) =>
                  handleEndConditionFieldChange(
                    "resumeSessionOnRetry",
                    e.target.checked
                  )
                }
                className="w-4 h-4 accent-focus-border cursor-pointer"
              />
              <label
                htmlFor="settings-end-resume-session-on-retry"
                className="text-[11px] font-semibold text-description-fg cursor-pointer"
                title="When enabled, retries continue in the same session. Uncheck to start a fresh session for each retry."
              >
                Resume Session on Retry
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Always-visible footer with quick toggle buttons */}
      <div
        ref={footerRef}
        className={`flex items-center justify-center gap-1 px-2 border-t border-panel-border flex-shrink-0 py-2${isCLIManaged ? " pointer-events-none opacity-60" : ""}`}
      >
        <IconToggleButton
          active={globalSettings.executionMode === EXECUTION_MODES.INTERACTIVE}
          onToggle={(active) =>
            handleExecutionModeChange(active ? EXECUTION_MODES.INTERACTIVE : EXECUTION_MODES.HEADLESS)
          }
          activeIcon="debug-console"
          inactiveIcon="terminal"
          activeTooltip="Interactive mode: terminal visible"
          inactiveTooltip="Headless mode: runs in background"
          activeLabel="Interactive"
          inactiveLabel="Headless"
          narrow={isFooterNarrow}
        />
        <IconToggleButton
          active={globalSettings.respectGitignore}
          onToggle={handleRespectGitignoreChange}
          activeIcon="repo-selected"
          inactiveIcon="repo"
          activeTooltip="Respecting .gitignore for completions"
          inactiveTooltip="All files included for completions (ignoring .gitignore)"
          activeLabel="Excluding ignored files"
          inactiveLabel="Including all files"
          narrow={isFooterNarrow}
        />
        <button
          onClick={handleOpenSettings}
          title="Open VS Code settings"
          className="flex items-center gap-1 px-1 bg-transparent border-none cursor-pointer leading-none transition-colors text-description-fg hover:text-foreground ml-auto"
        >
          <i className="codicon codicon-lg codicon-settings-gear" />
          {!isFooterNarrow && (
            <span className="text-[10px] font-medium">Settings...</span>
          )}
        </button>
      </div>
    </div>
  );
};
