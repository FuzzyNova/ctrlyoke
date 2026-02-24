import React, { useState, useCallback, useEffect } from "react";
import {
  useSettingsStore,
  type WorkflowProperties,
} from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import {
  MESSAGE_TYPES,
  HARNESS_IDS,
  HARNESS_STATUS_STRINGS,
  type HarnessId,
  type HarnessStatusString,
} from "../../types/messages";
import { PanelBar, IconToggleButton } from "../shared";

/**
 * Harness display information
 */
const HARNESS_INFO: Record<HarnessId, { name: string; description: string }> = {
  [HARNESS_IDS.COPILOT_CLI]: {
    name: "Copilot CLI",
    description: "GitHub Copilot CLI (recommended)",
  },
  [HARNESS_IDS.COPILOT_CHAT]: {
    name: "Copilot Chat",
    description: "VS Code Chat window (fallback)",
  },
  [HARNESS_IDS.CLAUDE_CLI]: {
    name: "Claude CLI",
    description: "Anthropic Claude Code CLI",
  },
  [HARNESS_IDS.CODEX_CLI]: {
    name: "Codex CLI",
    description: "OpenAI Codex CLI",
  },
};

/**
 * Status indicator component
 */
const StatusIndicator: React.FC<{
  status: HarnessStatusString;
  narrow?: boolean;
}> = ({ status, narrow = false }) => {
  const statusConfig: Record<
    HarnessStatusString,
    { color: string; text: string; animate: boolean }
  > = {
    [HARNESS_STATUS_STRINGS.CHECKING]: {
      color: "bg-yellow-400",
      text: "Checking...",
      animate: true,
    },
    [HARNESS_STATUS_STRINGS.AVAILABLE]: {
      color: "bg-green-500",
      text: "Available",
      animate: false,
    },
    [HARNESS_STATUS_STRINGS.UNAVAILABLE]: {
      color: "bg-red-400",
      text: "Not Available",
      animate: false,
    },
  };

  const config = statusConfig[status];

  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-description-fg">
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${config.color} ${config.animate ? "animate-pulse" : ""}`}
      />
      {!narrow && config.text}
    </span>
  );
};

/**
 * Set as Default link with animation
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
    <a
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && handleClick()}
      className={`text-[10px] font-semibold uppercase text-link-fg hover:underline cursor-pointer transition-colors ${
        state === "success" ? "text-green-500" : ""
      } ${state === "fading" ? "opacity-0" : ""}`}
      title="Set this as the default for new workflows"
    >
      {state === "success" ? "✓ Default" : "Set as Default"}
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
 * Custom styled harness dropdown with status indicators
 */
const HarnessDropdown: React.FC<{
  id: string;
  value: string;
  onChange: (value: string) => void;
  harnessStatus: Record<
    string,
    { status: HarnessStatusString; available?: boolean }
  >;
}> = ({ id, value, onChange, harnessStatus }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownRef, isNarrow] = useElementNarrow<HTMLDivElement>(160);

  const handleSelect = (harnessId: string) => {
    onChange(harnessId);
    setIsOpen(false);
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  return (
    <div className="relative inline-block w-full" ref={dropdownRef}>
      <button
        id={id}
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border text-left flex items-center justify-between h-7"
      >
        <span>{HARNESS_INFO[value as HarnessId]?.name || value}</span>
        <div className="flex items-center gap-1">
          <StatusIndicator
            status={harnessStatus[value as HarnessId]?.status || "checking"}
            narrow={isNarrow}
          />
          <i
            className={`codicon codicon-chevron-${isOpen ? "up" : "down"} text-[10px]`}
          />
        </div>
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-0 bg-dropdown-bg border border-dropdown-border z-50 shadow-lg">
          {Object.entries(HARNESS_IDS).map(([, harness]) => {
            const status = harnessStatus[harness as HarnessId];
            const isAvailable = status?.available !== false;
            const isChecking = status?.status === "checking";
            const isSelected = value === harness;

            return (
              <button
                key={harness}
                onClick={() => handleSelect(harness)}
                disabled={!isAvailable && !isChecking}
                className={`w-full px-2 py-1.5 text-xs text-left flex items-center justify-between focus:outline-none border-none ${
                  isSelected
                    ? "bg-dropdown-selected-bg"
                    : "hover:bg-list-hover-bg"
                } ${
                  !isAvailable && !isChecking
                    ? "opacity-50 cursor-not-allowed"
                    : "cursor-pointer"
                }`}
              >
                <span>
                  {HARNESS_INFO[harness as HarnessId]?.name || harness}
                </span>
                <StatusIndicator
                  status={
                    harnessStatus[harness as HarnessId]?.status || "checking"
                  }
                  narrow={isNarrow}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

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
  const { settingsCollapsed, toggleSettingsCollapse } = useUiStore();
  const {
    availableAgents,
    harnessStatus: harnessStatus,
    globalSettings,
    workflowProperties,
    getModelsForHarness: getModelsForHarness,
    getEffectiveHarness: getEffectiveHarness,
    getEffectiveModel,
    getEffectiveAgent,
    getEffectiveResumeSession,
    getEffectiveAllowDynamicExtension,
  } = useSettingsStore();
  useWorkflowStore(); // For re-renders when workflow changes

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
  const [footerRef, isFooterNarrow] = useElementNarrow<HTMLDivElement>(200);

  // Get current effective values
  const effectiveHarness = getEffectiveHarness();
  const effectiveModel = getEffectiveModel();
  const effectiveAgent = getEffectiveAgent();
  const effectiveResumeSession = getEffectiveResumeSession();
  const effectiveAllowDynamicExtension = getEffectiveAllowDynamicExtension();

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
      const globalValue =
        globalSettings[property as keyof typeof globalSettings];
      return workflowValue !== globalValue;
    },
    [workflowProperties, globalSettings, effectiveHarness]
  );

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const handleHarnessChange = useCallback(
    (harness: string) => {
      // Optimistic update (like vanilla implementation)
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("harness", harness);

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "harness",
        value: harness,
      });

      // Update model dropdown options for new harness (like old implementation)
      // Get models for the new harness
      const newHarnessModels = getModelsForHarness(harness as any);

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

        // Update model optimistically
        settingsStore.updateWorkflowProperty("model", defaultModel);

        // Send model update to extension
        vscode.postMessage({
          type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
          property: "model",
          value: defaultModel,
        });
      }
    },
    [vscode, getModelsForHarness]
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
      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("agent", agent || undefined);

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
      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("resumeSession", checked);

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "resumeSession",
        value: checked,
      });
      // Clear session ID when resume is disabled
      if (!checked) {
        setSessionIdInput("");
        settingsStore.updateWorkflowProperty("sessionId", undefined);
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
    (value: string) => {
      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty(
        "allowDynamicExtension",
        value === "true"
      );

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
    (field: string, value: string | number) => {
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
    (property: string, value: unknown) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.SET_AS_DEFAULT,
        property,
        value,
        harness: property === "model" ? effectiveHarness : undefined,
      });
    },
    [vscode, effectiveHarness]
  );

  const handleRespectGitignoreChange = useCallback(
    (checked: boolean) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_CONFIG,
        key: "respectGitignoreForCompletions",
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
        title="Settings"
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
        aria-label="Collapse settings"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && toggleSettingsCollapse()}
      >
        <div className="flex items-center gap-1 text-description-fg hover:text-foreground transition-colors">
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
          className="text-[11px] text-link-fg hover:underline hover:bg-list-hover-bg px-1 py-0.5 rounded"
          title="Open VS Code settings"
        >
          More...
        </button>
      </div>

      {/* Body - Scrollable */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-3 space-y-4">
          {/* Harness */}
          <FormField
            label="Harness"
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
            />
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
              className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
            >
              {currentHarnessModels.length === 0 ? (
                <option value="" disabled>
                  Loading models...
                </option>
              ) : (
                currentHarnessModels.map((model) => (
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
              className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
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
              className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
            >
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </FormField>

          {/* Resume Session & Session ID */}
          <div className="flex flex-col gap-1">
            {/* Row 1: Checkbox + label + set as default */}
            <div className="flex items-center gap-2 mt-1">
              <input
                type="checkbox"
                id="settings-resume-session"
                checked={effectiveResumeSession}
                onChange={(e) => handleResumeSessionChange(e.target.checked)}
                className="w-4 h-4 accent-focus-border cursor-pointer"
              />
              <label
                htmlFor="settings-resume-session"
                className="text-[11px] font-semibold uppercase text-description-fg cursor-pointer"
                title="Resume Session continues existing session. Session ID below resumes a specific session or reuses another prompt's session (by number)."
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

            {/* Row 2: Session ID input (animated, visible only when resume session is enabled) */}
            <div
              className={`transition-all duration-300 ${
                effectiveResumeSession
                  ? "max-h-[40px] opacity-100"
                  : "max-h-0 opacity-0 overflow-hidden"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0 mt-1">
                <input
                  type="text"
                  id="settings-session-id"
                  value={sessionIdInput}
                  onChange={(e) => handleSessionIdChange(e.target.value)}
                  placeholder="Enter session ID or prompt number"
                  className="min-w-0 w-full px-2 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border h-7"
                  title="Enter session ID (UUID) or prompt number (e.g., 1, 2, 3)"
                />
              </div>
            </div>
          </div>

          {/* End Condition Section */}
          {/* Enable checkbox */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="settings-end-condition-enabled"
              checked={endConditionEnabled}
              onChange={(e) => handleEndConditionToggle(e.target.checked)}
              className="w-4 h-4 accent-focus-border cursor-pointer"
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
            {/* Script */}
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

            {/* Returns */}
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

            {/* Timeout */}
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

            {/* Max Retries */}
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

            {/* Retry Prompt */}
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
          </div>
        </div>
      </div>

      {/* Always-visible footer with quick toggle buttons */}
      <div
        ref={footerRef}
        className="flex items-center justify-center gap-1 px-2 border-t border-panel-border flex-shrink-0 h-[35px]"
      >
        <IconToggleButton
          active={globalSettings.executionMode === "interactive"}
          onToggle={(active) =>
            handleExecutionModeChange(active ? "interactive" : "headless")
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
      </div>
    </div>
  );
};
