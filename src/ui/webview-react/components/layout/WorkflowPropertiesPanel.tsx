import React, { useState, useCallback, useEffect } from "react";
import {
  useSettingsStore,
  type WorkflowProperties,
  type GlobalSettings,
} from "../../store/settingsStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useUiStore } from "../../store/uiStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { useDrawerTabOverrides } from "../../hooks/useDrawerTabOverrides";
import {
  MESSAGE_TYPES,
  SESSION_ID_SENTINELS,
  RUNNER_IDS,
  HARNESS_IDS,
  type PriorContext,
  type HarnessId,
  type ToolPermissionMode,
} from "../../types/messages";
import {
  DROPDOWN_NAMESPACES,
  modelNamespaceForHarness,
  getResumeSessionOptions,
} from "../../types/dropdownNamespaces";
import { triggerPanelAnimation } from "@utils/panelAnimation";
import {
  PanelBar,
  CustomSelect,
  MultiCheckboxDropdown,
  HarnessDropdown,
  harnessCategory,
  PriorContextSelect,
  DrawerTabBar,
  DrawerRow,
  McpServersEditor,
  type McpServersValue,
  PERMISSION_MODE_OPTIONS,
  getPermissionHarnessSupport,
} from "../shared";
import { HooksEditor } from "../editor/HooksEditor";
import { DRAWER_PAGES, type DrawerPage } from "../../types/drawerPages";
import { PERMISSION_MODES } from "../../../../types/DashboardConstants";
import {
  COMPARE_SOURCE_LABELS,
  type EndConditionCompareSource,
} from "../../utils/endCondition";
import type { SelectOption } from "../shared";

/** Single breakpoint (px) where the settings drawer switches to narrow layout */
const SETTINGS_DRAWER_BREAKPOINT = 400;

const COMPARE_SOURCE_OPTIONS: SelectOption[] = (
  ["auto", "stdout", "stderr", "exitCode"] as EndConditionCompareSource[]
).map((v) => ({ value: v, label: COMPARE_SOURCE_LABELS[v] }));

const BUTTON_STATE = {
  IDLE: "idle",
  SUCCESS: "success",
  FADING: "fading",
} as const;
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
    <button
      type="button"
      onClick={handleClick}
      className={`text-[10px] font-semibold uppercase text-link-fg hover:underline cursor-pointer transition-colors ${
        state === BUTTON_STATE.SUCCESS ? "text-green-500" : ""
      } ${state === BUTTON_STATE.FADING ? "opacity-0" : ""}`}
      title="Set this as the default for new workflows"
    >
      {state === BUTTON_STATE.SUCCESS ? "✓ Default" : "Set as Default"}
    </button>
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
  className?: string;
}> = ({
  label,
  description,
  htmlFor,
  children,
  setAsDefaultButton,
  className,
}) => (
  <div className={`flex flex-col gap-1${className ? ` ${className}` : ""}`}>
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
 * WorkflowPropertiesPanel Component
 *
 * Collapsible panel for configuring:
 * - Harness settings (harness, model, agent)
 * - Workflow properties (execution mode, resume session, dynamic queue)
 * - End condition configuration
 * - Quick access to VS Code settings
 */
export const WorkflowPropertiesPanel: React.FC<{
  panelBarOrientation?: "horizontal" | "vertical";
  onRequestClose?: () => void;
}> = ({ panelBarOrientation = "vertical", onRequestClose }) => {
  const vscode = useVsCodeApi();
  const {
    settingsCollapsed,
    toggleSettingsCollapse,
    hiddenDropdownOptions,
    hideDropdownOption,
    unhideDropdownOption,
    loadedWorkflows,
    activeWorkflowId,
    mcpLocalServers,
    mcpLocalServersLoading,
    mcpLocalServersError,
    mcpRegistryServers,
    mcpRegistryLoading,
    mcpRegistryError,
    mcpWorkspaceServers,
    mcpWorkspaceServersLoading,
    setMcpLocalServersLoading,
    setMcpRegistryLoading,
    setMcpWorkspaceServersLoading,
    setMcpWorkspaceServers,
  } = useUiStore();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy ===
    RUNNER_IDS.CLI;
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
    getEffectivePriorContext,
    getEffectiveAdditionalArgs,
  } = useSettingsStore();

  // Active drawer page
  const [activePage, setActivePage] = useState<DrawerPage>(
    DRAWER_PAGES.HARNESS
  );

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

  // Local string state for number inputs — prevents auto-reset when clearing the field
  const [endTimeoutInput, setEndTimeoutInput] = useState(
    String((workflowProperties.endCondition as any)?.timeout ?? 30000)
  );
  const [endMaxRetriesInput, setEndMaxRetriesInput] = useState(
    String((workflowProperties.endCondition as any)?.maxRetries ?? 0)
  );

  const endConditionAny = workflowProperties.endCondition as any;
  const endTimeoutValue = endConditionAny?.timeout;
  const endMaxRetriesValue = endConditionAny?.maxRetries;

  useEffect(() => {
    setEndTimeoutInput(String(endTimeoutValue ?? 30000));
    setEndMaxRetriesInput(String(endMaxRetriesValue ?? 0));
  }, [workflowProperties.endCondition, endTimeoutValue, endMaxRetriesValue]);

  // Single breakpoint for all three layout zones (body rows, tab labels, footer toggles)
  const [drawerRef, isNarrow] = useElementNarrow<HTMLDivElement>(
    SETTINGS_DRAWER_BREAKPOINT
  );

  // Get current effective values
  const effectiveHarness = getEffectiveHarness();
  const effectiveModel = getEffectiveModel();
  const effectiveAgent = getEffectiveAgent();
  const effectiveSkills = getEffectiveSkills();
  const effectiveResumeSession = getEffectiveResumeSession();
  const effectivePriorContext = getEffectivePriorContext();
  const effectiveAdditionalArgs = getEffectiveAdditionalArgs();

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
      // Deep comparison for mcpServers — null and [] are both "no servers" and
      // must not trigger the "Set as Default" button when the global is also empty.
      if (property === "mcpServers") {
        const normalize = (v: unknown) => (Array.isArray(v) ? v : []);
        return (
          JSON.stringify(normalize(workflowValue)) !==
          JSON.stringify(normalize(globalSettings.mcpServers))
        );
      }
      // Deep comparison for hooks
      if (property === "hooks") {
        const normalize = (v: unknown) => (Array.isArray(v) ? v : []);
        return (
          JSON.stringify(normalize(workflowValue)) !==
          JSON.stringify(normalize(globalSettings.hooks))
        );
      }
      // Deep comparison for toolPermissions — normalize null/undefined/none
      // to a canonical form so the button hides when values match the global defaults.
      if (property === "toolPermissions") {
        const wv = workflowValue as WorkflowProperties["toolPermissions"];
        const gv = globalSettings.toolPermissions;
        // null/undefined/none all mean "no override" — compare as empty
        const normalizePerms = (
          v:
            | WorkflowProperties["toolPermissions"]
            | GlobalSettings["toolPermissions"]
        ) => {
          if (
            v === null ||
            v === undefined ||
            v.mode === PERMISSION_MODES.NONE
          ) {
            return {
              mode: PERMISSION_MODES.NONE,
              allowedTools: [] as string[],
              deniedTools: [] as string[],
            };
          }
          return {
            mode: v.mode ?? PERMISSION_MODES.ALLOW_ALL,
            allowedTools: v.allowedTools ?? [],
            deniedTools: v.deniedTools ?? [],
          };
        };
        return (
          JSON.stringify(normalizePerms(wv)) !==
          JSON.stringify(normalizePerms(gv))
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

      // Snapshot the full workflowProperties after all updates so this action
      // is tracked as a single undo entry.
      useWorkflowStore
        .getState()
        .setUndoWorkflowProperties(
          useSettingsStore.getState().workflowProperties
        );

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTIES,
        properties: updates,
      });
    },
    [vscode]
  );

  const syncWorkflowPropertiesForUndo = useCallback(() => {
    useWorkflowStore
      .getState()
      .setUndoWorkflowProperties(
        useSettingsStore.getState().workflowProperties
      );
  }, []);

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
      syncWorkflowPropertiesForUndo();

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "model",
        value: model,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleAgentChange = useCallback(
    (agent: string) => {
      // Optimistic update — store raw value (including "" for explicit "None")
      // so that getEffectiveAgent() can distinguish "no override" (undefined)
      // from "explicitly set to None" (""), which allows clearing a global default.
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("agent", agent);
      syncWorkflowPropertiesForUndo();

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "agent",
        value: agent,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleSkillsChange = useCallback(
    (skills: string[]) => {
      // Optimistic update — store raw array (including [] for explicit "None")
      // so that getEffectiveSkills() can distinguish "no override" (undefined)
      // from "explicitly cleared" ([]), which allows clearing a global default.
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("skills", skills);
      syncWorkflowPropertiesForUndo();

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "skills",
        value: skills,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleResumeSessionChange = useCallback(
    (v: string) => {
      if (v === SESSION_ID_SENTINELS.FINAL_STEP) {
        setSessionIdInput(SESSION_ID_SENTINELS.FINAL_STEP);
        postWorkflowPropertiesUpdate({
          resumeSession: true,
          sessionId: SESSION_ID_SENTINELS.FINAL_STEP,
        });
        return;
      }
      const checked = v === "yes";
      const updates: Partial<WorkflowProperties> = { resumeSession: checked };
      // Clear session ID when disabling or when switching away from Final Step Session.
      // Use "" instead of undefined so the value survives JSON serialization and the
      // extension receives the clear instruction (undefined is stripped by JSON.stringify).
      if (
        !checked ||
        workflowProperties.sessionId === SESSION_ID_SENTINELS.FINAL_STEP
      ) {
        setSessionIdInput("");
        updates.sessionId = "";
      }
      postWorkflowPropertiesUpdate(updates);
    },
    [postWorkflowPropertiesUpdate, workflowProperties.sessionId]
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
      syncWorkflowPropertiesForUndo();

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "sessionId",
        value: parsedValue,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleMcpServersChange = useCallback(
    (newValue: McpServersValue) => {
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty(
        "mcpServers",
        newValue as WorkflowProperties["mcpServers"]
      );
      syncWorkflowPropertiesForUndo();

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "mcpServers",
        value: newValue,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleHooksChange = useCallback(
    (newValue: object[] | null | undefined) => {
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty(
        "hooks",
        newValue as WorkflowProperties["hooks"]
      );
      syncWorkflowPropertiesForUndo();

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "hooks",
        value: newValue,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleRequestLocalServers = useCallback(() => {
    setMcpLocalServersLoading(true);
    vscode.postMessage({ type: MESSAGE_TYPES.REQUEST_MCP_LOCAL_SERVERS });
  }, [vscode, setMcpLocalServersLoading]);

  const handleSearchRegistry = useCallback(
    (query: string, cursor?: string, updatedSince?: string) => {
      setMcpRegistryLoading(true);
      vscode.postMessage({
        type: MESSAGE_TYPES.REQUEST_MCP_REGISTRY,
        query,
        cursor,
        updatedSince,
      });
    },
    [vscode, setMcpRegistryLoading]
  );

  const handleRequestWorkspaceServers = useCallback(() => {
    setMcpWorkspaceServersLoading(true);
    vscode.postMessage({ type: MESSAGE_TYPES.REQUEST_MCP_WORKSPACE_SERVERS });
  }, [vscode, setMcpWorkspaceServersLoading]);

  const handleWorkspaceServersChange = useCallback(
    (servers: import("@root/types/FlightPathTypes").McpServerConfig[]) => {
      setMcpWorkspaceServers(servers);
      vscode.postMessage({
        type: MESSAGE_TYPES.SAVE_MCP_WORKSPACE_SERVERS,
        servers,
      });
    },
    [vscode, setMcpWorkspaceServers]
  );

  const handleToolPermissionsChange = useCallback(
    (value: WorkflowProperties["toolPermissions"]) => {
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("toolPermissions", value);
      syncWorkflowPropertiesForUndo();

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "toolPermissions",
        value: value,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleAdditionalArgsChange = useCallback(
    (value: string) => {
      const settingsStore = useSettingsStore.getState();
      // Store the empty string explicitly (not undefined) so the extension
      // receives the update and "Set as Default" can appear when the field
      // is cleared while a non-empty VS Code default exists.
      settingsStore.updateWorkflowProperty("additionalArgs", value);
      syncWorkflowPropertiesForUndo();

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "additionalArgs",
        value: value,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handlePriorContextChange = useCallback(
    (value: PriorContext | undefined) => {
      const settingsStore = useSettingsStore.getState();
      settingsStore.updateWorkflowProperty("priorContext", value);
      syncWorkflowPropertiesForUndo();

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "priorContext",
        value: value,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode]
  );

  const handleEndConditionToggle = useCallback(
    (enabled: boolean) => {
      setEndConditionEnabled(enabled);

      // Optimistic update
      const settingsStore = useSettingsStore.getState();
      if (!enabled) {
        settingsStore.updateWorkflowProperty("endCondition", undefined);
        syncWorkflowPropertiesForUndo();
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
        syncWorkflowPropertiesForUndo();
        vscode.postMessage({
          type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
          property: "endCondition",
          value: defaultEndCondition,
        });
      }
    },
    [syncWorkflowPropertiesForUndo, vscode]
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
      syncWorkflowPropertiesForUndo();

      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
        property: "endCondition",
        value: updatedEndCondition,
      });
    },
    [syncWorkflowPropertiesForUndo, vscode, workflowProperties.endCondition]
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

  const tabOverrides = useDrawerTabOverrides(
    workflowProperties,
    globalSettings
  );

  // ============================================================================
  // RENDER
  // ============================================================================

  // In mobile mode (onRequestClose present), disable all collapse interactions —
  // the panel is a full-screen overlay and has its own close button.
  const isMobileMode = Boolean(onRequestClose);

  function handleToggle() {
    if (isMobileMode) return;
    triggerPanelAnimation();
    toggleSettingsCollapse();
  }

  if (settingsCollapsed && !isMobileMode) {
    return (
      <PanelBar
        orientation={panelBarOrientation}
        icon="settings"
        title="Workflow Properties"
        onClick={handleToggle}
      />
    );
  }

  const endCondition = workflowProperties.endCondition || {};

  // Permissions page derived values
  const toolPerms = workflowProperties.toolPermissions;
  const permMode =
    toolPerms === null
      ? PERMISSION_MODES.NONE
      : (toolPerms?.mode ?? PERMISSION_MODES.ALLOW_ALL);
  // Fall back to global settings when workflow doesn't have lists yet
  const effectiveAllowedTools =
    toolPerms?.allowedTools ?? globalSettings.toolPermissions.allowedTools;
  const effectiveDeniedTools =
    toolPerms?.deniedTools ?? globalSettings.toolPermissions.deniedTools;
  const harnessSupport = getPermissionHarnessSupport(
    effectiveHarness as HarnessId
  );

  return (
    <div ref={drawerRef} className="flex flex-col h-full bg-sidebar-bg">
      {/* Section Header — clickable to collapse in desktop mode; non-interactive in mobile */}
      <div
        className={`flex items-center justify-between h-[30px] px-2 border-b border-panel-border${isMobileMode ? "" : " cursor-pointer select-none"}`}
        onClick={isMobileMode ? undefined : handleToggle}
        role={isMobileMode ? undefined : "button"}
        aria-label={isMobileMode ? undefined : "Collapse workflow properties"}
        tabIndex={isMobileMode ? undefined : 0}
        onKeyDown={
          isMobileMode ? undefined : (e) => e.key === "Enter" && handleToggle()
        }
      >
        <div className="flex items-center gap-1 text-description-fg hover:text-foreground transition-colors">
          {!isMobileMode && (
            <i className="codicon codicon-chevron-right text-[12px] rotate-90 transition-transform duration-150" />
          )}
          <i className="codicon codicon-settings text-[14px]" />
          <span className="text-[11px] font-semibold uppercase tracking-wide ml-0.5">
            Workflow Properties
          </span>
        </div>
        {onRequestClose && (
          <button
            className="flex items-center justify-center w-[20px] h-[20px] rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onRequestClose();
            }}
            title="Close workflow properties"
            aria-label="Close workflow properties"
          >
            <i className="codicon codicon-close text-[12px]" />
          </button>
        )}
      </div>

      {/* Body - Scrollable (pointer-events disabled in CLI watch mode) */}
      <div
        className={`flex-1 overflow-y-auto${activePage === DRAWER_PAGES.MCP ? " flex flex-col" : ""}${isCLIManaged ? " pointer-events-none opacity-60 select-none" : ""}`}
      >
        <div
          className={`px-4 py-2${activePage === DRAWER_PAGES.MCP ? " flex flex-col flex-1 min-h-0 gap-2" : ` space-y-2${activePage === DRAWER_PAGES.PERMISSIONS ? " min-h-full flex flex-col" : ""}`}`}
        >
          {activePage === DRAWER_PAGES.HARNESS && (
            <>
              {/* Row 1: Harness + Model */}
              <DrawerRow narrow={isNarrow}>
                <FormField
                  label={`Harness${harnessCategory(effectiveHarness) === "cli" ? " (CLI)" : harnessCategory(effectiveHarness) === "chat" ? " (Chat)" : ""}`}
                  htmlFor="settings-harness"
                  description="AI harness for execution"
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="harness"
                      show={isDifferentFromGlobal("harness")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "harness",
                          workflowProperties.harness
                        )
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
                    onUnhideOption={(v) =>
                      unhideDropdownOption(modelNamespace, v)
                    }
                    nonHideableValues={["default", ""]}
                  />
                </FormField>
              </DrawerRow>

              {/* Row 2: Agent + Skills */}
              <DrawerRow narrow={isNarrow}>
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
                      { value: "", label: "None" },
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
              </DrawerRow>

              {/* Row 3: Additional Args */}
              <DrawerRow narrow={isNarrow}>
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
                    aria-label="Additional arguments"
                    value={effectiveAdditionalArgs}
                    onChange={(e) => handleAdditionalArgsChange(e.target.value)}
                    placeholder="e.g. --effort high --max-turns 10"
                    className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono h-7"
                  />
                </FormField>
                <div />
              </DrawerRow>
            </>
          )}

          {activePage === DRAWER_PAGES.CONTEXT && (
            <>
              {/* Row 1: Resume Session (with paired Session ID) + Prior Context */}
              <DrawerRow narrow={isNarrow}>
                <FormField
                  label="Resume Session"
                  htmlFor="settings-resume-session"
                  description="Resume Session continues existing session. Session ID below resumes a specific session or reuses another prompt's session (by number). 'Final Step Session' resumes the session established by the Final Step gate."
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
                    value={
                      workflowProperties.sessionId ===
                        SESSION_ID_SENTINELS.FINAL_STEP &&
                      effectiveResumeSession
                        ? SESSION_ID_SENTINELS.FINAL_STEP
                        : effectiveResumeSession
                          ? "yes"
                          : "no"
                    }
                    onChange={handleResumeSessionChange}
                    options={[...getResumeSessionOptions()]}
                  />
                  {/* Session ID input — always visible, grayed out when not applicable */}
                  <div
                    className={`mt-1 ${
                      effectiveResumeSession &&
                      workflowProperties.sessionId !==
                        SESSION_ID_SENTINELS.FINAL_STEP
                        ? ""
                        : "opacity-50 pointer-events-none"
                    }`}
                    title={
                      !effectiveResumeSession
                        ? "Enable Resume Session to specify a Session ID"
                        : workflowProperties.sessionId ===
                            SESSION_ID_SENTINELS.FINAL_STEP
                          ? "Using Final Step Session — no explicit Session ID needed"
                          : undefined
                    }
                  >
                    <input
                      type="text"
                      id="settings-session-id"
                      aria-label="Session ID"
                      value={sessionIdInput}
                      onChange={(e) => handleSessionIdChange(e.target.value)}
                      placeholder="Enter session ID or prompt number"
                      className="w-full px-2 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border h-7"
                      title="Enter session ID (UUID) or prompt number (e.g., 1, 2, 3)"
                    />
                  </div>
                </FormField>

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
                  />
                </FormField>
              </DrawerRow>
            </>
          )}

          {activePage === DRAWER_PAGES.VALIDATION && (
            <>
              {/* Enable checkbox */}
              <label
                htmlFor="settings-end-condition-enabled"
                className="flex items-center gap-2 text-[11px] font-semibold uppercase text-description-fg cursor-pointer"
                title="Validation runs after each prompt completes. Individual prompts can override or disable this."
              >
                <input
                  type="checkbox"
                  id="settings-end-condition-enabled"
                  aria-label="Enable End Condition"
                  checked={endConditionEnabled}
                  onChange={(e) => handleEndConditionToggle(e.target.checked)}
                  className="w-4 h-4 accent-focus-border cursor-pointer mt-1"
                />
                Enable End Condition
              </label>

              {/* End condition fields — always visible, grayed out when disabled */}
              <div
                className={`space-y-3 ${
                  endConditionEnabled ? "" : "opacity-50 pointer-events-none"
                }`}
                title={
                  endConditionEnabled
                    ? undefined
                    : "Enable End Condition to configure validation"
                }
              >
                {/* Row 1: Script (full width) */}
                <label
                  htmlFor="settings-end-script"
                  className="flex flex-col gap-1"
                >
                  <span className="text-[11px] font-semibold text-description-fg">
                    Script:
                  </span>
                  <input
                    type="text"
                    id="settings-end-script"
                    aria-label="Script"
                    value={(endCondition as any).script || ""}
                    onChange={(e) =>
                      handleEndConditionFieldChange("script", e.target.value)
                    }
                    placeholder="npm test"
                    className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                  />
                </label>

                {/* Row 2: Compare Source + Expected Return */}
                <DrawerRow narrow={isNarrow}>
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="settings-end-compare-source"
                      className="text-[11px] font-semibold text-description-fg"
                      title="Auto: 'true'/'false' check exit code; other values check stdout. Stdout: always compare stdout. Stderr: compare stderr. Exit Code: compare numeric exit code."
                    >
                      Compare Source:
                    </label>
                    <CustomSelect
                      id="settings-end-compare-source"
                      value={(endCondition as any).compareSource ?? "auto"}
                      onChange={(v) =>
                        handleEndConditionFieldChange(
                          "compareSource",
                          v as EndConditionCompareSource
                        )
                      }
                      options={COMPARE_SOURCE_OPTIONS}
                    />
                    <span className="text-[10px] text-description-fg">
                      {((endCondition as any).compareSource ?? "auto") ===
                      "auto"
                        ? "'true'/'false' use exit code; other values check stdout"
                        : ((endCondition as any).compareSource ?? "auto") ===
                            "stdout"
                          ? "Compares stdout output (requires clean exit)"
                          : ((endCondition as any).compareSource ?? "auto") ===
                              "stderr"
                            ? "Compares stderr output (exit code not checked)"
                            : "Compares numeric exit code — use '0', '1', or 'true'/'false'"}
                    </span>
                  </div>

                  <label
                    htmlFor="settings-end-returns"
                    className="flex flex-col gap-1"
                  >
                    <span className="text-[11px] font-semibold text-description-fg">
                      Expected Return:
                    </span>
                    <input
                      type="text"
                      id="settings-end-returns"
                      aria-label="Expected Return"
                      value={(endCondition as any).returns || ""}
                      onChange={(e) =>
                        handleEndConditionFieldChange("returns", e.target.value)
                      }
                      placeholder="true"
                      className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                    />
                  </label>
                </DrawerRow>

                {/* Row 3: Timeout + Max Retries */}
                <DrawerRow narrow={isNarrow}>
                  <label
                    htmlFor="settings-end-timeout"
                    className="flex flex-col gap-1"
                  >
                    <span className="text-[11px] font-semibold text-description-fg">
                      Timeout (ms):
                    </span>
                    <input
                      type="number"
                      id="settings-end-timeout"
                      aria-label="Timeout in milliseconds"
                      value={endTimeoutInput}
                      onChange={(e) => setEndTimeoutInput(e.target.value)}
                      onBlur={() => {
                        const parsed = parseInt(endTimeoutInput);
                        const value =
                          isNaN(parsed) || parsed < 1000 ? 30000 : parsed;
                        setEndTimeoutInput(String(value));
                        handleEndConditionFieldChange("timeout", value);
                      }}
                      min={1000}
                      className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                    />
                  </label>

                  <label
                    htmlFor="settings-end-retries"
                    className="flex flex-col gap-1"
                  >
                    <span className="text-[11px] font-semibold text-description-fg">
                      Max Retries:
                    </span>
                    <input
                      type="number"
                      id="settings-end-retries"
                      aria-label="Maximum retries"
                      value={endMaxRetriesInput}
                      onChange={(e) => setEndMaxRetriesInput(e.target.value)}
                      onBlur={() => {
                        const parsed = parseInt(endMaxRetriesInput);
                        const value = isNaN(parsed) ? 0 : parsed;
                        setEndMaxRetriesInput(String(value));
                        handleEndConditionFieldChange("maxRetries", value);
                      }}
                      min={-1}
                      className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                    />
                  </label>
                </DrawerRow>

                {/* Retry Prompt (full width) */}
                <label
                  htmlFor="settings-end-retry-prompt"
                  className="flex flex-col gap-1"
                >
                  <span className="text-[11px] font-semibold text-description-fg">
                    Retry Prompt:
                  </span>
                  <textarea
                    id="settings-end-retry-prompt"
                    aria-label="Retry Prompt"
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
                    className="w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border resize-none"
                  />
                </label>

                {/* Resume Session on Retry (full width) */}
                <label
                  htmlFor="settings-end-resume-session-on-retry"
                  className="flex items-center gap-2 mt-1 text-[11px] font-semibold text-description-fg cursor-pointer"
                  title="When enabled, retries continue in the same session. Uncheck to start a fresh session for each retry."
                >
                  <input
                    type="checkbox"
                    id="settings-end-resume-session-on-retry"
                    aria-label="Resume Session on Retry"
                    checked={(endCondition as any).resumeSessionOnRetry ?? true}
                    onChange={(e) =>
                      handleEndConditionFieldChange(
                        "resumeSessionOnRetry",
                        e.target.checked
                      )
                    }
                    className="w-4 h-4 accent-focus-border cursor-pointer"
                  />
                  Resume Session on Retry
                </label>
              </div>
            </>
          )}

          {activePage === DRAWER_PAGES.MCP && (
            <div className="flex-1 flex flex-col min-h-0">
              <FormField
                label="MCP Servers"
                description="MCP servers to attach to the harness for this workflow. Include FlightPath to enable dynamic queue extension. Add custom McpServerConfig entries for additional MCP servers. Set to None to explicitly disable MCP injection."
                className="flex-1 min-h-0"
                setAsDefaultButton={
                  <SetAsDefaultButton
                    property="mcpServers"
                    show={isDifferentFromGlobal("mcpServers")}
                    onSetDefault={() =>
                      handleSetAsDefault(
                        "mcpServers",
                        workflowProperties.mcpServers
                      )
                    }
                  />
                }
              >
                <McpServersEditor
                  value={workflowProperties.mcpServers as McpServersValue}
                  onChange={handleMcpServersChange}
                  showDefault={false}
                  fillHeight={true}
                  onRequestLocalServers={handleRequestLocalServers}
                  onSearchRegistry={handleSearchRegistry}
                  localServers={mcpLocalServers}
                  isLoadingLocal={mcpLocalServersLoading}
                  localServersError={mcpLocalServersError}
                  registryServers={mcpRegistryServers}
                  isLoadingRegistry={mcpRegistryLoading}
                  registryError={mcpRegistryError}
                  workspaceServers={mcpWorkspaceServers}
                  isLoadingWorkspaceServers={mcpWorkspaceServersLoading}
                  onRequestWorkspaceServers={handleRequestWorkspaceServers}
                  onWorkspaceServersChange={handleWorkspaceServersChange}
                />
              </FormField>
            </div>
          )}

          {activePage === DRAWER_PAGES.PERMISSIONS && (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Copilot Chat: not applicable */}
              {harnessSupport === "n/a" && (
                <p className="text-[10px] text-description-fg mb-2">
                  ℹ️ Tool permissions apply to CLI harnesses only and are
                  ignored for Copilot Chat.
                </p>
              )}

              <div
                className={`flex-1 flex flex-col min-h-0${harnessSupport === "n/a" ? " opacity-60" : ""}`}
              >
                {/* Permission Mode */}
                <FormField
                  label="Permission Mode"
                  htmlFor="settings-permission-mode"
                  description="Tool permission mode for CLI harnesses"
                  setAsDefaultButton={
                    <SetAsDefaultButton
                      property="toolPermissions"
                      show={isDifferentFromGlobal("toolPermissions")}
                      onSetDefault={() =>
                        handleSetAsDefault(
                          "toolPermissions",
                          workflowProperties.toolPermissions
                        )
                      }
                    />
                  }
                >
                  <CustomSelect
                    id="settings-permission-mode"
                    value={permMode}
                    onChange={(mode) => {
                      handleToolPermissionsChange({
                        mode: mode as ToolPermissionMode,
                        allowedTools: effectiveAllowedTools,
                        deniedTools: effectiveDeniedTools,
                      });
                    }}
                    options={PERMISSION_MODE_OPTIONS}
                  />
                </FormField>

                {/* Allowed / Denied Tools textareas — always visible, disabled by mode */}
                <div className="flex-1 flex flex-col gap-2 min-h-0 mt-2">
                  {/* Mode-only harness warning */}
                  {harnessSupport === "mode-only" && (
                    <p className="text-[10px] text-description-fg">
                      {effectiveHarness === HARNESS_IDS.CODEX_CLI
                        ? "ℹ️ Codex CLI uses sandbox/approval modes rather than individual tool patterns. Allowed Tools and Denied Tools lists are ignored."
                        : effectiveHarness === HARNESS_IDS.OPENCODE_CLI
                          ? "ℹ️ OpenCode CLI manages permissions via config file. Tool pattern lists are ignored."
                          : "ℹ️ Gemini CLI uses approval modes only. Tool pattern lists are ignored."}
                    </p>
                  )}

                  <FormField
                    label="Allowed Tools"
                    htmlFor="settings-allowed-tools"
                    description="Tool patterns to allow (one per line). Uses Copilot CLI format — auto-converted for Claude/Qwen."
                    className="flex-1 min-h-0"
                  >
                    <textarea
                      id="settings-allowed-tools"
                      aria-label="Allowed Tools"
                      value={effectiveAllowedTools.join("\n")}
                      onChange={(e) => {
                        handleToolPermissionsChange({
                          ...(toolPerms || {}),
                          allowedTools: e.target.value.split("\n"),
                          deniedTools: effectiveDeniedTools,
                        });
                      }}
                      disabled={
                        harnessSupport === "mode-only" ||
                        permMode !== PERMISSION_MODES.CUSTOM
                      }
                      placeholder={"read\nglob\ngrep"}
                      className={`flex-1 min-h-[60px] w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border resize-none font-mono${
                        harnessSupport === "mode-only" ||
                        permMode !== PERMISSION_MODES.CUSTOM
                          ? " opacity-50 cursor-not-allowed"
                          : ""
                      }`}
                    />
                  </FormField>

                  <FormField
                    label="Denied Tools"
                    htmlFor="settings-denied-tools"
                    description="Tool patterns to deny (one per line, takes precedence over allow list)."
                    className="flex-1 min-h-0"
                  >
                    <textarea
                      id="settings-denied-tools"
                      aria-label="Denied Tools"
                      value={effectiveDeniedTools.join("\n")}
                      onChange={(e) => {
                        handleToolPermissionsChange({
                          ...(toolPerms || {}),
                          allowedTools: effectiveAllowedTools,
                          deniedTools: e.target.value.split("\n"),
                        });
                      }}
                      disabled={
                        harnessSupport === "mode-only" ||
                        permMode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL ||
                        permMode === PERMISSION_MODES.NONE
                      }
                      placeholder={"shell(rm:*)\nwrite"}
                      className={`flex-1 min-h-[60px] w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border resize-none font-mono${
                        harnessSupport === "mode-only" ||
                        permMode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL ||
                        permMode === PERMISSION_MODES.NONE
                          ? " opacity-50 cursor-not-allowed"
                          : ""
                      }`}
                    />
                  </FormField>
                </div>
              </div>
            </div>
          )}

          {activePage === DRAWER_PAGES.HOOKS && (
            <>
              <FormField
                label="User Hooks"
                description="User-defined hooks to run alongside FlightPath's completion-detection hooks. Supported events vary by harness."
                setAsDefaultButton={
                  <SetAsDefaultButton
                    property="hooks"
                    show={isDifferentFromGlobal("hooks")}
                    onSetDefault={() =>
                      handleSetAsDefault("hooks", workflowProperties.hooks)
                    }
                  />
                }
              >
                <HooksEditor
                  value={workflowProperties.hooks}
                  onChange={handleHooksChange}
                  showDefault={false}
                />
              </FormField>
            </>
          )}
        </div>
      </div>

      {/* Tab Bar */}
      <DrawerTabBar
        activeTab={activePage}
        onTabChange={setActivePage}
        harnessId={effectiveHarness as HarnessId}
        isNarrow={isNarrow}
        tabOverrides={tabOverrides}
      />
    </div>
  );
};
