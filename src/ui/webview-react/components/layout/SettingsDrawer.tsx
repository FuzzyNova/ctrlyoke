import React, { useState, useCallback, useEffect } from "react";
import {
  useSettingsStore,
  type WorkflowProperties,
} from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import {
  MESSAGE_TYPES,
  PROVIDER_IDS,
  type ProviderId,
} from "../../types/messages";
import { PanelBar } from "../shared";

/**
 * Provider display information
 */
const PROVIDER_INFO: Record<ProviderId, { name: string; description: string }> =
  {
    [PROVIDER_IDS.COPILOT_CLI]: {
      name: "Copilot CLI",
      description: "GitHub Copilot CLI (recommended)",
    },
    [PROVIDER_IDS.COPILOT_CHAT]: {
      name: "Copilot Chat",
      description: "VS Code Chat window (fallback)",
    },
    [PROVIDER_IDS.CLAUDE_CLI]: {
      name: "Claude CLI",
      description: "Anthropic Claude Code CLI",
    },
    [PROVIDER_IDS.CODEX_CLI]: {
      name: "Codex CLI",
      description: "OpenAI Codex CLI",
    },
  };

/**
 * Status indicator component
 */
const StatusIndicator: React.FC<{
  status: "checking" | "available" | "not_available";
}> = ({ status }) => {
  const statusConfig = {
    checking: {
      color: "bg-yellow-400",
      text: "Checking...",
      animate: true,
    },
    available: {
      color: "bg-green-500",
      text: "Available",
      animate: false,
    },
    not_available: {
      color: "bg-red-400",
      text: "Not Available",
      animate: false,
    },
  };

  const config = statusConfig[status];

  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-[var(--vscode-descriptionForeground)]">
      <span
        className={`w-2 h-2 rounded-full ${config.color} ${config.animate ? "animate-pulse" : ""}`}
      />
      {config.text}
    </span>
  );
};

/**
 * Set as Default button with animation
 */
const SetAsDefaultButton: React.FC<{
  property: string;
  show: boolean;
  onSetDefault: () => void;
}> = ({ show, onSetDefault }) => {
  const [state, setState] = useState<"idle" | "success" | "fading">("idle");

  const handleClick = useCallback(() => {
    onSetDefault();
    setState("success");
    setTimeout(() => setState("fading"), 2000);
    setTimeout(() => setState("idle"), 2300);
  }, [onSetDefault]);

  if (!show && state === "idle") return null;

  return (
    <button
      onClick={handleClick}
      className={`text-[10px] font-semibold uppercase text-[var(--vscode-textLink-foreground)] hover:underline hover:bg-[var(--vscode-list-hoverBackground)] px-1 py-0.5 rounded transition-all ${
        state === "success" ? "text-green-500" : ""
      } ${state === "fading" ? "opacity-0" : ""}`}
      title="Set this as the default for all workflows"
    >
      {state === "success" ? "✓ Default" : "Set as Default"}
    </button>
  );
};

/**
 * Collapsible section header
 */
const SectionHeader: React.FC<{
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  icon?: string;
}> = ({ title, isOpen, onToggle, icon }) => (
  <button
    onClick={onToggle}
    className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase text-[var(--vscode-foreground)] bg-[var(--vscode-sideBarSectionHeader-background)] hover:bg-[var(--vscode-list-hoverBackground)] transition-colors rounded-t"
  >
    <span className="flex items-center gap-2">
      {icon && <i className={`codicon codicon-${icon}`} />}
      {title}
    </span>
    <i
      className={`codicon codicon-chevron-${isOpen ? "down" : "right"} text-[10px]`}
    />
  </button>
);

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
        className="text-[11px] font-semibold uppercase text-[var(--vscode-descriptionForeground)]"
      >
        {label}
      </label>
      {setAsDefaultButton}
    </div>
    {children}
    {description && (
      <span className="text-[11px] text-[var(--vscode-descriptionForeground)] leading-tight">
        {description}
      </span>
    )}
  </div>
);

/**
 * SettingsPanel Component
 *
 * Collapsible panel for configuring:
 * - Provider settings (provider, model, agent)
 * - Workflow properties (execution mode, resume session, dynamic queue)
 * - End condition configuration
 * - Quick access to VS Code settings
 */
export const SettingsPanel: React.FC = () => {
  const vscode = useVsCodeApi();
  const { settingsCollapsed, toggleSettingsCollapse } = useUiStore();
  const {
    availableAgents,
    providerStatus,
    globalSettings,
    workflowProperties,
    getModelsForProvider,
    getEffectiveProvider,
    getEffectiveModel,
    getEffectiveAgent,
    getEffectiveResumeSession,
    getEffectiveAllowDynamicExtension,
  } = useSettingsStore();
  useWorkflowStore(); // For re-renders when workflow changes

  // Section collapse states
  const [providerSectionOpen, setProviderSectionOpen] = useState(true);
  const [workflowSectionOpen, setWorkflowSectionOpen] = useState(true);
  const [endConditionSectionOpen, setEndConditionSectionOpen] = useState(false);

  // End condition enabled state
  const [endConditionEnabled, setEndConditionEnabled] = useState(
    workflowProperties.endCondition !== null &&
      workflowProperties.endCondition !== undefined
  );

  // Session ID input state
  const [sessionIdInput, setSessionIdInput] = useState("");

  // Update end condition state when workflow properties change
  useEffect(() => {
    setEndConditionEnabled(
      workflowProperties.endCondition !== null &&
        workflowProperties.endCondition !== undefined
    );
  }, [workflowProperties.endCondition]);

  // Get current effective values
  const effectiveProvider = getEffectiveProvider();
  const effectiveModel = getEffectiveModel();
  const effectiveAgent = getEffectiveAgent();
  const effectiveResumeSession = getEffectiveResumeSession();
  const effectiveAllowDynamicExtension = getEffectiveAllowDynamicExtension();

  // Get models for current provider
  const currentProviderModels = getModelsForProvider(effectiveProvider);

  // Check if workflow value differs from global setting
  const isDifferentFromGlobal = useCallback(
    (property: keyof WorkflowProperties) => {
      const workflowValue = workflowProperties[property];
      const globalValue =
        globalSettings[property as keyof typeof globalSettings];
      return workflowValue !== undefined && workflowValue !== globalValue;
    },
    [workflowProperties, globalSettings]
  );

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const handleProviderChange = useCallback(
    (provider: string) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "provider",
        value: provider,
      });
    },
    [vscode]
  );

  const handleModelChange = useCallback(
    (model: string) => {
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
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "agent",
        value: agent || undefined,
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
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "resumeSession",
        value: checked,
      });
      // Clear session ID when resume is disabled
      if (!checked) {
        setSessionIdInput("");
        vscode.postMessage({
          type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
          property: "sessionId",
          value: undefined,
        });
      }
    },
    [vscode]
  );

  const handleSessionIdChange = useCallback(
    (value: string) => {
      setSessionIdInput(value);
      // Parse as number if valid integer, otherwise keep as string
      const parsedValue = /^\d+$/.test(value.trim())
        ? parseInt(value.trim(), 10)
        : value.trim() || undefined;
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "sessionId",
        value: parsedValue,
      });
    },
    [vscode]
  );

  const handleDynamicExtensionChange = useCallback(
    (value: string) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "allowDynamicExtension",
        value: value === "true",
      });
    },
    [vscode]
  );

  const handleEndConditionToggle = useCallback(
    (enabled: boolean) => {
      setEndConditionEnabled(enabled);
      if (!enabled) {
        vscode.postMessage({
          type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
          property: "endCondition",
          value: undefined,
        });
      } else {
        // Initialize with defaults
        vscode.postMessage({
          type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
          property: "endCondition",
          value: {
            script: "",
            returns: "true",
            timeout: 30000,
            maxRetries: 0,
            retryPrompt: "",
          },
        });
      }
    },
    [vscode]
  );

  const handleEndConditionFieldChange = useCallback(
    (field: string, value: string | number) => {
      const currentEndCondition = workflowProperties.endCondition || {};
      const updatedEndCondition = {
        ...currentEndCondition,
        [field]: value,
      };
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "endCondition",
        value: updatedEndCondition,
      });
    },
    [vscode, workflowProperties.endCondition]
  );

  const handleSetAsDefault = useCallback(
    (property: string, value: unknown) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.SET_AS_DEFAULT,
        property,
        value,
        provider: property === "model" ? effectiveProvider : undefined,
      });
    },
    [vscode, effectiveProvider]
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
        orientation="vertical"
        icon="settings-gear"
        title="Settings"
        onClick={toggleSettingsCollapse}
      />
    );
  }

  const endCondition = workflowProperties.endCondition || {};

  return (
    <div className="flex flex-col h-full bg-[var(--vscode-sideBar-background)]">
      {/* Section Header - clickable to collapse */}
      <div
        className="flex items-center justify-between h-[30px] px-2 border-b border-[var(--vscode-panel-border)] cursor-pointer select-none"
        onClick={toggleSettingsCollapse}
        role="button"
        aria-label="Collapse settings"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && toggleSettingsCollapse()}
      >
        <div className="flex items-center gap-1 text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] transition-colors">
          <i className="codicon codicon-chevron-right text-[12px] rotate-90 transition-transform duration-150" />
          <i className="codicon codicon-settings-gear text-[14px]" />
          <span className="text-[11px] font-semibold uppercase tracking-wide ml-0.5">
            Settings
          </span>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleOpenSettings();
          }}
          className="text-[11px] text-[var(--vscode-textLink-foreground)] hover:underline hover:bg-[var(--vscode-list-hoverBackground)] px-1 py-0.5 rounded"
          title="Open VS Code settings"
        >
          More...
        </button>
      </div>

      {/* Body - Scrollable */}
      <div className="flex-1 overflow-y-auto">
        {/* Provider Settings Section */}
        <div className="border-b border-[var(--vscode-panel-border)]">
          <SectionHeader
            title="Provider Settings"
            icon="server-environment"
            isOpen={providerSectionOpen}
            onToggle={() => setProviderSectionOpen(!providerSectionOpen)}
          />
          {providerSectionOpen && (
            <div className="px-4 py-3 space-y-4">
              {/* Provider */}
              <FormField
                label="Provider"
                htmlFor="settings-provider"
                description="AI provider for execution"
                setAsDefaultButton={
                  <SetAsDefaultButton
                    property="provider"
                    show={isDifferentFromGlobal("provider")}
                    onSetDefault={() =>
                      handleSetAsDefault(
                        "provider",
                        workflowProperties.provider
                      )
                    }
                  />
                }
              >
                <select
                  id="settings-provider"
                  value={effectiveProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className="w-full px-2 py-1 text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                >
                  {Object.entries(PROVIDER_IDS).map(([, id]) => {
                    const status = providerStatus[id as ProviderId];
                    const isAvailable = status?.available !== false;
                    const isChecking = status?.status === "checking";

                    let label = PROVIDER_INFO[id as ProviderId]?.name || id;
                    if (isChecking) {
                      label += " (Checking...)";
                    } else if (!isAvailable) {
                      label += " (Not Available)";
                    }

                    return (
                      <option
                        key={id}
                        value={id}
                        disabled={!isAvailable && !isChecking}
                      >
                        {label}
                      </option>
                    );
                  })}
                </select>
                {/* Status indicator */}
                <div className="mt-1">
                  <StatusIndicator
                    status={
                      providerStatus[effectiveProvider]?.status || "checking"
                    }
                  />
                </div>
              </FormField>

              {/* Model */}
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
                <select
                  id="settings-model"
                  value={effectiveModel}
                  onChange={(e) => handleModelChange(e.target.value)}
                  className="w-full px-2 py-1 text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                >
                  {currentProviderModels.length === 0 ? (
                    <option value="" disabled>
                      Loading models...
                    </option>
                  ) : (
                    currentProviderModels.map((model) => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))
                  )}
                </select>
              </FormField>

              {/* Agent */}
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
                <select
                  id="settings-agent"
                  value={effectiveAgent || ""}
                  onChange={(e) => handleAgentChange(e.target.value)}
                  className="w-full px-2 py-1 text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                >
                  <option value="">None (default behavior)</option>
                  {availableAgents.map((agent) => (
                    <option key={agent.path} value={agent.name || agent.path}>
                      {agent.name || "Unknown Agent"}
                      {agent.description ? ` - ${agent.description}` : ""}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
          )}
        </div>

        {/* Workflow Properties Section */}
        <div className="border-b border-[var(--vscode-panel-border)]">
          <SectionHeader
            title="Workflow Properties"
            icon="symbol-property"
            isOpen={workflowSectionOpen}
            onToggle={() => setWorkflowSectionOpen(!workflowSectionOpen)}
          />
          {workflowSectionOpen && (
            <div className="px-4 py-3 space-y-4">
              {/* Execution Mode */}
              <FormField
                label="Execution Mode"
                htmlFor="settings-execution-mode"
                description="Interactive shows terminal, headless runs in background"
              >
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer text-xs">
                    <input
                      type="radio"
                      name="execution-mode"
                      value="interactive"
                      checked={globalSettings.executionMode === "interactive"}
                      onChange={(e) =>
                        handleExecutionModeChange(e.target.value)
                      }
                      className="accent-[var(--vscode-focusBorder)]"
                    />
                    Interactive
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-xs">
                    <input
                      type="radio"
                      name="execution-mode"
                      value="headless"
                      checked={globalSettings.executionMode === "headless"}
                      onChange={(e) =>
                        handleExecutionModeChange(e.target.value)
                      }
                      className="accent-[var(--vscode-focusBorder)]"
                    />
                    Headless
                  </label>
                </div>
              </FormField>

              {/* Resume Session */}
              <div className="grid grid-cols-[auto_1fr] gap-4">
                {/* Resume Session Checkbox */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between min-h-[18px]">
                    <label
                      htmlFor="settings-resume-session"
                      className="text-[11px] font-semibold uppercase text-[var(--vscode-descriptionForeground)]"
                    >
                      Resume Session
                    </label>
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
                  </div>
                  <input
                    type="checkbox"
                    id="settings-resume-session"
                    checked={effectiveResumeSession}
                    onChange={(e) =>
                      handleResumeSessionChange(e.target.checked)
                    }
                    className="w-4 h-4 accent-[var(--vscode-focusBorder)] cursor-pointer"
                  />
                </div>

                {/* Session ID Input */}
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="settings-session-id"
                    className="text-[11px] font-semibold uppercase text-[var(--vscode-descriptionForeground)]"
                  >
                    Session ID
                  </label>
                  <input
                    type="text"
                    id="settings-session-id"
                    value={sessionIdInput}
                    onChange={(e) => handleSessionIdChange(e.target.value)}
                    disabled={!effectiveResumeSession}
                    placeholder={
                      effectiveResumeSession
                        ? "Enter session ID or prompt number"
                        : "Enable Resume Session first"
                    }
                    className="w-full px-2 py-1 text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Enter session ID (UUID) or prompt number (e.g., 1, 2, 3)"
                  />
                </div>
              </div>
              <span className="text-[11px] text-[var(--vscode-descriptionForeground)] leading-tight block -mt-2">
                Resume Session continues existing session; Session ID resumes
                specific session or reuses another prompt's session (by number)
              </span>

              {/* Allow Dynamic Extension */}
              <FormField
                label="Allow Dynamic Extension"
                htmlFor="settings-dynamic-ext"
                description="Allow prompts to extend the workflow queue"
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
                <select
                  id="settings-dynamic-ext"
                  value={String(effectiveAllowDynamicExtension)}
                  onChange={(e) => handleDynamicExtensionChange(e.target.value)}
                  className="w-full px-2 py-1 text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                >
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </FormField>
            </div>
          )}
        </div>

        {/* End Condition Section */}
        <div className="border-b border-[var(--vscode-panel-border)]">
          <SectionHeader
            title="Workflow End Condition"
            icon="checklist"
            isOpen={endConditionSectionOpen}
            onToggle={() =>
              setEndConditionSectionOpen(!endConditionSectionOpen)
            }
          />
          {endConditionSectionOpen && (
            <div className="px-4 py-3 space-y-3">
              {/* Enable checkbox */}
              <label className="flex items-center gap-2 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={endConditionEnabled}
                  onChange={(e) => handleEndConditionToggle(e.target.checked)}
                  className="w-4 h-4 accent-[var(--vscode-focusBorder)]"
                />
                <span>Apply end condition to all prompts</span>
              </label>

              {/* End condition fields */}
              <div
                className={`space-y-3 transition-all duration-300 ${
                  endConditionEnabled
                    ? "max-h-[500px] opacity-100"
                    : "max-h-0 opacity-0 overflow-hidden"
                }`}
              >
                {/* Help text */}
                <div className="flex items-start gap-2 px-2 py-2 text-[11px] text-[var(--vscode-descriptionForeground)] bg-[var(--vscode-textBlockQuote-background)] border-l-2 border-[var(--vscode-textBlockQuote-border)]">
                  <i className="codicon codicon-info mt-0.5" />
                  <span>
                    Validation runs after each prompt completes. Individual
                    prompts can override or disable this.
                  </span>
                </div>

                {/* Script */}
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="settings-end-script"
                    className="text-[11px] font-semibold text-[var(--vscode-descriptionForeground)]"
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
                    className="w-full px-2 py-1 text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                  />
                </div>

                {/* Returns */}
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="settings-end-returns"
                    className="text-[11px] font-semibold text-[var(--vscode-descriptionForeground)]"
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
                    className="w-full px-2 py-1 text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                  />
                </div>

                {/* Timeout */}
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="settings-end-timeout"
                    className="text-[11px] font-semibold text-[var(--vscode-descriptionForeground)]"
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
                    className="w-full px-2 py-1 text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                  />
                </div>

                {/* Max Retries */}
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="settings-end-retries"
                    className="text-[11px] font-semibold text-[var(--vscode-descriptionForeground)]"
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
                    className="w-full px-2 py-1 text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                  />
                </div>

                {/* Retry Prompt */}
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="settings-end-retry-prompt"
                    className="text-[11px] font-semibold text-[var(--vscode-descriptionForeground)]"
                  >
                    Retry Prompt:
                  </label>
                  <textarea
                    id="settings-end-retry-prompt"
                    value={(endCondition as any).retryPrompt || ""}
                    onChange={(e) =>
                      handleEndConditionFieldChange(
                        "retryPrompt",
                        e.target.value
                      )
                    }
                    rows={3}
                    placeholder={
                      "Validation failed: {error}\n\nPlease fix the issues."
                    }
                    className="w-full px-2 py-1 text-xs bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] resize-none"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
};
