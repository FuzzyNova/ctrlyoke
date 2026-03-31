import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import {
  useEditorStore,
  END_CONDITION_DEFAULTS,
} from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";
import {
  HARNESS_IDS,
  type HarnessId,
  type PriorContext,
  type ToolPermissionsOverride,
  type ToolPermissionMode,
} from "../../types/messages";
import { PERMISSION_MODES } from "../../../../types/DashboardConstants";
import {
  DROPDOWN_NAMESPACES,
  modelNamespaceForHarness,
  getResumeSessionOptions,
} from "../../types/dropdownNamespaces";
import { SESSION_ID_SENTINELS } from "../../types/messages";
import {
  CustomSelect,
  DrawerTabBar,
  DrawerRow,
  HarnessDropdown,
  HARNESS_DISPLAY_NAMES,
  harnessCategory,
  PriorContextSelect,
  PRIOR_CONTEXT_KEYWORD_LABELS,
  SkillsSelect,
  McpServersEditor,
  buildMcpDefaultLabel,
  type McpServersValue,
  PERMISSION_MODE_OPTIONS,
  getPermissionHarnessSupport,
  buildPermissionsDefaultLabel,
} from "../shared";
import { HooksEditor } from "./HooksEditor";
import { DRAWER_PAGES, type DrawerPage } from "../../types/drawerPages";
import {
  COMPARE_SOURCE_LABELS,
  type EndConditionCompareSource,
} from "../../utils/endCondition";
import type { SelectOption } from "../shared";

/** Max height for dropdowns inside the PropertiesDrawer (px, not vh — the drawer has a fixed height). */
const DRAWER_DROPDOWN_MAX_HEIGHT = "150px";

const COMPARE_SOURCE_OPTIONS: SelectOption[] = (
  ["auto", "stdout", "stderr", "exitCode"] as EndConditionCompareSource[]
).map((v) => ({ value: v, label: COMPARE_SOURCE_LABELS[v] }));

interface PropertiesDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * PropertiesDrawer - Slide-up panel for prompt properties
 *
 * Layout (two-column grid throughout, matching SettingsDrawer ordering):
 * - Row 1: Harness + Model
 * - Row 2: Agent + Skills
 * - Row 3: Additional Args + Prior Context
 * - Row 4: Allow Dynamic Extension + Resume Session (with paired Session ID)
 * - End Condition section (full width)
 */
export const PropertiesDrawer: React.FC<PropertiesDrawerProps> = ({
  isOpen,
  onClose,
}) => {
  const {
    properties,
    selectedPromptIndex,
    setProperty,
    setEndCondition,
    updateEndConditionField,
    clearEndCondition,
  } = useEditorStore();
  const {
    availableAgents,
    availableSkills,
    globalSettings,
    workflowProperties,
    getModelsForHarness,
  } = useSettingsStore();
  const {
    hiddenDropdownOptions,
    hideDropdownOption,
    unhideDropdownOption,
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

  const vscode = useVsCodeApi();

  const handleRequestLocalServers = useCallback(() => {
    setMcpLocalServersLoading(true);
    vscode.postMessage({ type: MESSAGE_TYPES.REQUEST_MCP_LOCAL_SERVERS });
  }, [vscode, setMcpLocalServersLoading]);

  const handleSearchRegistry = useCallback(
    (query: string, cursor?: string) => {
      setMcpRegistryLoading(true);
      vscode.postMessage({
        type: MESSAGE_TYPES.REQUEST_MCP_REGISTRY,
        query,
        cursor,
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
  const [drawerRef, isNarrow] = useElementNarrow<HTMLDivElement>(576);

  // ── Resolved "Default (X)" labels ────────────────────────────────────────
  // Each label shows what value the prompt will actually use when set to Default,
  // resolving through the three-tier chain: prompt → workflow → global settings.

  const resolvedHarness = (workflowProperties.harness ??
    globalSettings.harness) as HarnessId;
  const defaultHarnessLabel = `Default (${HARNESS_DISPLAY_NAMES[resolvedHarness] ?? resolvedHarness})`;

  const resolvedModels = getModelsForHarness(resolvedHarness);
  const resolvedModelValue =
    workflowProperties.model ??
    globalSettings.harnessDefaultModels[resolvedHarness] ??
    globalSettings.model;
  const resolvedModelLabel =
    resolvedModels.find((m) => m.value === resolvedModelValue)?.label ??
    resolvedModelValue;
  const defaultModelLabel = `Default (${resolvedModelLabel || "None"})`;

  const resolvedAgent =
    workflowProperties.agent === undefined
      ? globalSettings.agent
      : workflowProperties.agent;
  const resolvedAgentName = !resolvedAgent
    ? "None"
    : (availableAgents.find(
        (a) => a.path === resolvedAgent || a.name === resolvedAgent
      )?.name ?? resolvedAgent);
  const defaultAgentLabel = `Default (${resolvedAgentName})`;

  const resolvedSkills =
    workflowProperties.skills === undefined
      ? (globalSettings.skills ?? [])
      : (workflowProperties.skills ?? []);
  const defaultSkillsLabel =
    resolvedSkills.length === 0
      ? "Default (None)"
      : resolvedSkills.length <= 2
        ? `Default (${resolvedSkills.join(", ")})`
        : `Default (${resolvedSkills.slice(0, 2).join(", ")} +${resolvedSkills.length - 2})`;

  const resolvedAdditionalArgs =
    workflowProperties.additionalArgs === undefined
      ? (globalSettings.harnessDefaultAdditionalArgs[resolvedHarness] ?? "")
      : workflowProperties.additionalArgs;
  const defaultAdditionalArgsLabel = !resolvedAdditionalArgs
    ? "Default (None)"
    : `Default (${resolvedAdditionalArgs})`;

  const resolvedResumeSession =
    workflowProperties.resumeSession ?? globalSettings.resumeSession;
  const resolvedSessionId = workflowProperties.sessionId;
  const defaultResumeSessionLabel =
    resolvedResumeSession &&
    resolvedSessionId === SESSION_ID_SENTINELS.FINAL_PROMPT
      ? "Default (Final Prompt Session)"
      : `Default (${resolvedResumeSession ? "Yes" : "No"})`;

  // Session ID display in prompt-level drawer
  const isSessionIdDefault = properties.resumeSession === undefined;
  const isSessionIdActive =
    properties.resumeSession === true &&
    properties.sessionId !== SESSION_ID_SENTINELS.FINAL_PROMPT;
  const sessionIdDisplayValue = isSessionIdActive
    ? (properties.sessionId ?? "")
    : isSessionIdDefault &&
        resolvedResumeSession &&
        resolvedSessionId !== SESSION_ID_SENTINELS.FINAL_PROMPT
      ? (resolvedSessionId ?? "")
      : "";
  const sessionIdTooltip = isSessionIdActive
    ? undefined
    : isSessionIdDefault
      ? "Using workflow-level Resume Session setting. Select Yes to override."
      : properties.resumeSession === true &&
          properties.sessionId === SESSION_ID_SENTINELS.FINAL_PROMPT
        ? "Using Final Prompt Session — no explicit Session ID needed"
        : "Set Resume Session to Yes to specify a Session ID";

  // Additional Args display mode
  const additionalArgsMode =
    properties.additionalArgs === undefined
      ? "default"
      : properties.additionalArgs === null
        ? "none"
        : "custom";
  const isAdditionalArgsActive = additionalArgsMode === "custom";
  const additionalArgsDisplayValue = isAdditionalArgsActive
    ? typeof properties.additionalArgs === "string"
      ? properties.additionalArgs
      : ""
    : additionalArgsMode === "default"
      ? (resolvedAdditionalArgs ?? "")
      : "";
  const additionalArgsTooltip = isAdditionalArgsActive
    ? undefined
    : additionalArgsMode === "default"
      ? "Inheriting from workflow settings. Select Custom to override."
      : "Set to None — no additional args will be passed";

  const resolvedMcpServers =
    workflowProperties.mcpServers !== undefined
      ? workflowProperties.mcpServers
      : globalSettings.mcpServers;
  const defaultMcpServersLabel = buildMcpDefaultLabel(
    resolvedMcpServers as McpServersValue
  );

  // ── Permissions page derived values ──────────────────────────────────────
  const defaultPermissionsLabel = buildPermissionsDefaultLabel(
    workflowProperties.toolPermissions
  );
  const effectivePermHarness = (properties.harness ??
    workflowProperties.harness ??
    globalSettings.harness) as HarnessId;
  const permHarnessSupport = getPermissionHarnessSupport(effectivePermHarness);

  // ── Hooks page derived values ───────────────────────────────────────────
  const resolvedHooks = useMemo(() => {
    const effective = useSettingsStore.getState().getEffectiveHooks();
    return Array.isArray(effective) ? effective : [];
  }, [properties.hooks, globalSettings.hooks]);

  const resolvedPriorContext =
    workflowProperties.priorContext ??
    (globalSettings.priorContext as PriorContext);
  const defaultPriorContextLabel = (() => {
    if (Array.isArray(resolvedPriorContext)) {
      return `Default (Custom: [${resolvedPriorContext.join(", ")}])`;
    }
    const label =
      PRIOR_CONTEXT_KEYWORD_LABELS[
        resolvedPriorContext as keyof typeof PRIOR_CONTEXT_KEYWORD_LABELS
      ];
    return `Default (${label ?? resolvedPriorContext})`;
  })();

  // Active page in the drawer tab navigation
  const [activePage, setActivePage] = useState<DrawerPage>(
    DRAWER_PAGES.HARNESS
  );

  // Reset to first page when drawer opens for a new prompt
  useEffect(() => {
    if (isOpen) {
      setActivePage(DRAWER_PAGES.HARNESS);
    }
  }, [isOpen, selectedPromptIndex]);

  // Get models for current harness
  const currentHarness = (properties.harness ??
    workflowProperties.harness ??
    globalSettings.harness) as HarnessId;
  const models = getModelsForHarness(currentHarness);
  const modelNamespace = modelNamespaceForHarness(currentHarness);

  // Handle harness change - also reset model to default
  const handleHarnessChange = (newHarness: string) => {
    setProperty("harness", newHarness === "default" ? undefined : newHarness);
    setProperty("model", undefined);
  };

  // Handle end condition enable/disable
  const handleEndConditionToggle = () => {
    if (properties.endCondition) {
      clearEndCondition();
    } else {
      setEndCondition({ ...END_CONDITION_DEFAULTS });
    }
  };

  return (
    <div
      ref={drawerRef}
      className={`properties-drawer absolute bottom-0 left-0 right-0 bg-sidebar-bg border-t-2 border-panel-border shadow-lg transition-transform duration-300 z-[100] h-full flex flex-col overflow-hidden ${
        isOpen ? "translate-y-0" : "translate-y-full"
      }`}
    >
      {/* Header */}
      <div className="drawer-header shrink-0 flex items-center justify-between px-4 py-0 border-b border-panel-border bg-sidebar-drop-bg z-10">
        <h3 className="text-xs font-semibold text-foreground uppercase">
          Prompt Properties
        </h3>
        <button
          className="btn-close-drawer w-6 h-6 flex items-center justify-center rounded opacity-70 hover:opacity-100 hover:bg-toolbar-hover-bg transition-all"
          onClick={onClose}
          title="Close properties drawer"
        >
          <i className="codicon codicon-close" />
        </button>
      </div>

      {/* Body - Scrollable */}
      <div
        className={`drawer-body flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-2${activePage === DRAWER_PAGES.PERMISSIONS ? " flex flex-col" : ""}`}
      >
        {/* Page: Harness */}
        {activePage === DRAWER_PAGES.HARNESS && (
          <div className="space-y-2">
            {/* Harness + Model */}
            <DrawerRow narrow={isNarrow}>
              {/* Harness */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-harness"
                  className="text-[11px] font-semibold uppercase text-description-fg"
                >
                  {`Harness${harnessCategory(properties.harness ?? "") === "cli" ? " (CLI)" : harnessCategory(properties.harness ?? "") === "chat" ? " (Chat)" : ""}`}
                </label>
                <HarnessDropdown
                  id="prop-harness"
                  value={properties.harness ?? "default"}
                  onChange={handleHarnessChange}
                  showDefault={true}
                  defaultLabel={defaultHarnessLabel}
                  showStatus={false}
                  hiddenValues={
                    hiddenDropdownOptions[DROPDOWN_NAMESPACES.HARNESS] ?? []
                  }
                  onHideOption={(v) =>
                    hideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)
                  }
                  onUnhideOption={(v) =>
                    unhideDropdownOption(DROPDOWN_NAMESPACES.HARNESS, v)
                  }
                  dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
                />
              </div>

              {/* Model */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-model"
                  className="text-[11px] font-semibold uppercase text-description-fg"
                >
                  Model
                </label>
                <CustomSelect
                  id="prop-model"
                  value={properties.model ?? "default"}
                  onChange={(v) =>
                    setProperty("model", v === "default" ? undefined : v)
                  }
                  options={[
                    { value: "default", label: defaultModelLabel },
                    ...(models.length === 0
                      ? [
                          {
                            value: "",
                            label: "Loading models...",
                            disabled: true,
                          },
                        ]
                      : models.map((m) => ({
                          value: m.value,
                          label: m.label,
                        }))),
                  ]}
                  namespace={modelNamespace}
                  hiddenValues={hiddenDropdownOptions[modelNamespace] ?? []}
                  onHideOption={(v) => hideDropdownOption(modelNamespace, v)}
                  onUnhideOption={(v) =>
                    unhideDropdownOption(modelNamespace, v)
                  }
                  nonHideableValues={["default", ""]}
                  dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
                />
              </div>
            </DrawerRow>

            {/* Row 2: Agent + Skills */}
            <DrawerRow narrow={isNarrow}>
              {/* Agent — single flat dropdown: Default / None / each agent */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-agent"
                  className="text-[11px] font-semibold uppercase text-description-fg"
                >
                  Agent
                </label>
                <CustomSelect
                  id="prop-agent"
                  value={
                    properties.agent === undefined
                      ? "default"
                      : properties.agent === null
                        ? "none"
                        : properties.agent
                  }
                  onChange={(v) => {
                    if (v === "default") {
                      setProperty("agent", undefined);
                    } else if (v === "none") {
                      setProperty("agent", null);
                    } else {
                      setProperty("agent", v);
                    }
                  }}
                  options={[
                    { value: "default", label: defaultAgentLabel },
                    { value: "none", label: "None" },
                    ...availableAgents.map((agent) => ({
                      value: agent.path,
                      label: agent.name,
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
                  nonHideableValues={["default"]}
                  dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
                />
              </div>

              {/* Skills — hybrid dropdown with Default/None keywords + checkbox list */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-skills"
                  className="text-[11px] font-semibold uppercase text-description-fg"
                >
                  Skills
                </label>
                <SkillsSelect
                  value={properties.skills as string[] | null | undefined}
                  onChange={(v) => setProperty("skills", v)}
                  availableSkills={availableSkills.map((s) => ({
                    name: s.name,
                    description: s.description || undefined,
                  }))}
                  defaultLabel={defaultSkillsLabel}
                  dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
                />
              </div>
            </DrawerRow>

            {/* Additional Args */}
            <DrawerRow narrow={isNarrow}>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-additional-args-mode"
                  className="text-[11px] font-semibold uppercase text-description-fg"
                  title="Extra CLI flags appended to FlightPath's standard argument set. Only applies to CLI harnesses."
                >
                  Additional Args
                </label>
                <CustomSelect
                  id="prop-additional-args-mode"
                  value={additionalArgsMode}
                  onChange={(v) => {
                    if (v === "default") {
                      setProperty("additionalArgs", undefined);
                    } else if (v === "none") {
                      setProperty("additionalArgs", null);
                    } else {
                      setProperty(
                        "additionalArgs",
                        typeof properties.additionalArgs === "string"
                          ? properties.additionalArgs
                          : ""
                      );
                    }
                  }}
                  options={[
                    { value: "default", label: defaultAdditionalArgsLabel },
                    { value: "none", label: "None (override to empty)" },
                    { value: "custom", label: "Custom" },
                  ]}
                  dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
                />
                {/* Narrow mode: input always below the dropdown */}
                {isNarrow && (
                  <div
                    className={
                      isAdditionalArgsActive
                        ? ""
                        : "opacity-50 pointer-events-none"
                    }
                    title={additionalArgsTooltip}
                  >
                    <input
                      type="text"
                      id="prop-additional-args"
                      value={additionalArgsDisplayValue}
                      onChange={(e) =>
                        setProperty("additionalArgs", e.target.value)
                      }
                      placeholder="e.g. --effort high"
                      className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                    />
                  </div>
                )}
              </div>

              {/* Wide mode: input in the right column, aligned to bottom */}
              {!isNarrow && (
                <div
                  className={`flex flex-col justify-end ${
                    isAdditionalArgsActive
                      ? ""
                      : "opacity-50 pointer-events-none"
                  }`}
                  title={additionalArgsTooltip}
                >
                  <input
                    type="text"
                    id="prop-additional-args-wide"
                    value={additionalArgsDisplayValue}
                    onChange={(e) =>
                      setProperty("additionalArgs", e.target.value)
                    }
                    placeholder="e.g. --effort high"
                    className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border font-mono"
                  />
                </div>
              )}
            </DrawerRow>
          </div>
        )}

        {/* Page: Context */}
        {activePage === DRAWER_PAGES.CONTEXT && (
          <div className="space-y-2">
            <DrawerRow narrow={isNarrow}>
              {/* Resume Session — paired control with Session ID below */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-resume-session"
                  className="text-[11px] font-semibold uppercase text-description-fg"
                >
                  Resume Session
                </label>
                <CustomSelect
                  id="prop-resume-session"
                  value={
                    properties.resumeSession === undefined
                      ? "default"
                      : properties.sessionId ===
                            SESSION_ID_SENTINELS.FINAL_PROMPT &&
                          properties.resumeSession
                        ? SESSION_ID_SENTINELS.FINAL_PROMPT
                        : properties.resumeSession
                          ? "yes"
                          : "no"
                  }
                  onChange={(v) => {
                    if (v === SESSION_ID_SENTINELS.FINAL_PROMPT) {
                      setProperty("resumeSession", true);
                      setProperty(
                        "sessionId",
                        SESSION_ID_SENTINELS.FINAL_PROMPT
                      );
                    } else if (v === "default") {
                      setProperty("resumeSession", undefined);
                      if (
                        properties.sessionId ===
                        SESSION_ID_SENTINELS.FINAL_PROMPT
                      ) {
                        setProperty("sessionId", "");
                      }
                    } else {
                      if (
                        properties.sessionId ===
                        SESSION_ID_SENTINELS.FINAL_PROMPT
                      ) {
                        setProperty("sessionId", "");
                      }
                      setProperty("resumeSession", v === "yes");
                    }
                  }}
                  options={[
                    ...getResumeSessionOptions(defaultResumeSessionLabel),
                  ]}
                  dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
                />
                {/* Session ID — always visible, grayed out when not applicable */}
                <div
                  className={
                    isSessionIdActive ? "" : "opacity-50 pointer-events-none"
                  }
                  title={sessionIdTooltip}
                >
                  <input
                    type="text"
                    id="prop-session-id"
                    value={sessionIdDisplayValue}
                    onChange={(e) => setProperty("sessionId", e.target.value)}
                    placeholder={
                      isSessionIdDefault
                        ? "Inherited from workflow"
                        : "Session ID or prompt number (e.g., 1)"
                    }
                    className="w-full px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                  />
                </div>
              </div>

              {/* Prior Context */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-prior-context"
                  className="text-[11px] font-semibold uppercase text-description-fg"
                  title="Inject prior prompt outputs into this prompt's text before sending to the AI"
                >
                  Prior Context
                </label>
                <PriorContextSelect
                  id="prop-prior-context"
                  value={properties.priorContext}
                  onChange={(v) => setProperty("priorContext", v)}
                  showDefault
                  defaultLabel={defaultPriorContextLabel}
                  dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
                />
              </div>
            </DrawerRow>
          </div>
        )}

        {/* Page: Validation */}
        {activePage === DRAWER_PAGES.VALIDATION && (
          <div className="space-y-2">
            <div>
              <div className="flex items-center gap-2 mb-3">
                <input
                  type="checkbox"
                  id="prop-end-enabled"
                  checked={!!properties.endCondition}
                  onChange={handleEndConditionToggle}
                  className="w-4 h-4 rounded border border-input-border"
                />
                <label
                  htmlFor="prop-end-enabled"
                  className="text-xs font-medium text-foreground cursor-pointer"
                >
                  Enable End Condition
                </label>
              </div>

              {/* End condition fields — always visible, grayed out when disabled */}
              <div
                className={`space-y-3 p-3 bg-editor-bg border border-panel-border rounded ${
                  properties.endCondition
                    ? ""
                    : "opacity-50 pointer-events-none"
                }`}
                title={
                  properties.endCondition
                    ? undefined
                    : "Enable End Condition to configure validation"
                }
              >
                {/* Script + Returns */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Script */}
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="prop-end-script"
                      className="text-xs font-medium text-foreground"
                    >
                      Script
                    </label>
                    <input
                      type="text"
                      id="prop-end-script"
                      value={properties.endCondition?.script || ""}
                      onChange={(e) =>
                        updateEndConditionField("script", e.target.value)
                      }
                      placeholder="npm test"
                      className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                    />
                  </div>

                  {/* Returns + Compare Source */}
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="prop-end-returns"
                      className="text-xs font-medium text-foreground"
                    >
                      Expected Return
                    </label>
                    <input
                      type="text"
                      id="prop-end-returns"
                      value={properties.endCondition?.returns || ""}
                      onChange={(e) =>
                        updateEndConditionField("returns", e.target.value)
                      }
                      placeholder="true"
                      className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                    />
                    <label
                      htmlFor="prop-end-compare-source"
                      className="text-xs font-medium text-foreground mt-1"
                      title="Auto: 'true'/'false' check exit code; other values check stdout. Stdout: always compare stdout (requires clean exit). Stderr: compare stderr output. Exit Code: compare the numeric exit code directly."
                    >
                      Compare Source
                    </label>
                    <CustomSelect
                      id="prop-end-compare-source"
                      value={properties.endCondition?.compareSource ?? "auto"}
                      onChange={(v) =>
                        updateEndConditionField(
                          "compareSource",
                          v as EndConditionCompareSource
                        )
                      }
                      options={COMPARE_SOURCE_OPTIONS}
                      dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
                    />
                    <span className="text-[10px] text-description-fg">
                      {(properties.endCondition?.compareSource ?? "auto") ===
                      "auto"
                        ? "'true'/'false' use exit code; other values check stdout"
                        : (properties.endCondition?.compareSource ?? "auto") ===
                            "stdout"
                          ? "Compares stdout output (requires clean exit)"
                          : (properties.endCondition?.compareSource ??
                                "auto") === "stderr"
                            ? "Compares stderr output (exit code not checked)"
                            : "Compares numeric exit code — use '0', '1', or 'true'/'false'"}
                    </span>
                  </div>
                </div>

                {/* Timeout + Max Retries */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Timeout */}
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="prop-end-timeout"
                      className="text-xs font-medium text-foreground"
                    >
                      Timeout (ms)
                    </label>
                    <input
                      type="number"
                      id="prop-end-timeout"
                      value={properties.endCondition?.timeout ?? 30000}
                      onChange={(e) =>
                        updateEndConditionField(
                          "timeout",
                          parseInt(e.target.value) || 30000
                        )
                      }
                      min={1000}
                      max={300000}
                      className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                    />
                  </div>

                  {/* Max Retries */}
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="prop-end-retries"
                      className="text-xs font-medium text-foreground"
                    >
                      Max Retries
                    </label>
                    <input
                      type="number"
                      id="prop-end-retries"
                      value={properties.endCondition?.maxRetries ?? 0}
                      onChange={(e) =>
                        updateEndConditionField(
                          "maxRetries",
                          parseInt(e.target.value) || 0
                        )
                      }
                      min={-1}
                      max={100}
                      className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
                    />
                    <span className="text-[10px] text-description-fg">
                      Use -1 for unlimited retries
                    </span>
                  </div>
                </div>

                {/* Retry Prompt (Full Width) */}
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="prop-end-retry-prompt"
                    className="text-xs font-medium text-foreground"
                  >
                    Retry Prompt
                  </label>
                  <textarea
                    id="prop-end-retry-prompt"
                    value={properties.endCondition?.retryPrompt || ""}
                    onChange={(e) =>
                      updateEndConditionField("retryPrompt", e.target.value)
                    }
                    placeholder={
                      "Validation failed: {error}\n\nPlease fix the issues."
                    }
                    rows={3}
                    className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border resize-y"
                  />
                  <span className="text-[10px] text-description-fg">
                    Use {"{error}"} placeholder for validation error message
                  </span>
                </div>

                {/* Resume Session on Retry */}
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="prop-end-resume-session-on-retry"
                    checked={
                      properties.endCondition?.resumeSessionOnRetry ?? true
                    }
                    onChange={(e) =>
                      updateEndConditionField(
                        "resumeSessionOnRetry",
                        e.target.checked
                      )
                    }
                    className="w-4 h-4 accent-focus-border cursor-pointer"
                  />
                  <label
                    htmlFor="prop-end-resume-session-on-retry"
                    className="text-xs font-medium text-foreground cursor-pointer"
                    title="When enabled, retries continue in the same session. Uncheck to start a fresh session for each retry."
                  >
                    Resume Session on Retry
                  </label>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Page: MCP */}
        {activePage === DRAWER_PAGES.MCP && (
          <div className="space-y-2">
            <label className="text-[11px] font-semibold uppercase text-description-fg">
              MCP Servers
            </label>
            <McpServersEditor
              value={properties.mcpServers as McpServersValue}
              onChange={(v) => setProperty("mcpServers", v)}
              defaultLabel={defaultMcpServersLabel}
              inheritedValue={resolvedMcpServers as McpServersValue}
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
          </div>
        )}

        {/* Page: Permissions */}
        {activePage === DRAWER_PAGES.PERMISSIONS && (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Copilot Chat: not applicable */}
            {permHarnessSupport === "n/a" && (
              <p className="text-[10px] text-description-fg mb-2">
                ℹ️ Tool permissions apply to CLI harnesses only and are ignored
                for Copilot Chat.
              </p>
            )}

            <div
              className={`flex-1 flex flex-col min-h-0${permHarnessSupport === "n/a" ? " opacity-60" : ""}`}
            >
              {/* Permission Mode */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-permission-mode"
                  className="text-[11px] font-semibold uppercase text-description-fg"
                  title="Tool permission mode override for this prompt"
                >
                  Permission Mode
                </label>
                <CustomSelect
                  id="prop-permission-mode"
                  value={
                    properties.toolPermissions === undefined
                      ? "default"
                      : properties.toolPermissions === null
                        ? PERMISSION_MODES.NONE
                        : (properties.toolPermissions.mode ?? PERMISSION_MODES.ALLOW_ALL)
                  }
                  onChange={(v) => {
                    if (v === "default") {
                      setProperty("toolPermissions", undefined);
                    } else {
                      const current =
                        (properties.toolPermissions as
                          | ToolPermissionsOverride
                          | undefined) || {};
                      setProperty("toolPermissions", {
                        ...current,
                        mode: v as ToolPermissionMode,
                      });
                    }
                  }}
                  options={[
                    { value: "default", label: defaultPermissionsLabel },
                    ...PERMISSION_MODE_OPTIONS,
                  ]}
                  dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
                />
              </div>

              {/* Allowed / Denied Tools textareas — always visible, disabled by mode */}
              {(() => {
                // Determine the effective permission mode for this prompt
                const effectivePermMode: string =
                  properties.toolPermissions === undefined
                    ? workflowProperties.toolPermissions === null
                      ? PERMISSION_MODES.NONE
                      : (workflowProperties.toolPermissions?.mode ?? PERMISSION_MODES.ALLOW_ALL)
                    : properties.toolPermissions === null
                      ? PERMISSION_MODES.NONE
                      : (properties.toolPermissions.mode ?? PERMISSION_MODES.ALLOW_ALL);
                const isInheriting = properties.toolPermissions === undefined;
                const allowedDisabled =
                  isInheriting ||
                  permHarnessSupport === "mode-only" ||
                  effectivePermMode !== PERMISSION_MODES.CUSTOM;
                const deniedDisabled =
                  isInheriting ||
                  permHarnessSupport === "mode-only" ||
                  effectivePermMode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL ||
                  effectivePermMode === PERMISSION_MODES.NONE;

                return (
                  <div
                    className={`flex-1 flex min-h-0 gap-2 mt-2 ${isNarrow ? "flex-col" : "flex-row"}`}
                  >
                    {/* Mode-only harness warning */}
                    {permHarnessSupport === "mode-only" && (
                      <p className="text-[10px] text-description-fg">
                        {effectivePermHarness === HARNESS_IDS.CODEX_CLI
                          ? "ℹ️ Codex CLI uses sandbox/approval modes rather than individual tool patterns. Allowed Tools and Denied Tools lists are ignored."
                          : effectivePermHarness === HARNESS_IDS.OPENCODE_CLI
                            ? "ℹ️ OpenCode CLI manages permissions via config file. Tool pattern lists are ignored."
                            : "ℹ️ Gemini CLI uses approval modes only. Tool pattern lists are ignored."}
                      </p>
                    )}

                    {/* Allowed Tools */}
                    <div className="flex-1 flex flex-col gap-1 min-h-0">
                      <label
                        htmlFor="prop-allowed-tools"
                        className="text-[11px] font-semibold uppercase text-description-fg"
                        title="Tool patterns to allow (one per line). Uses Copilot CLI format — auto-converted for Claude/Qwen."
                      >
                        Allowed Tools
                      </label>
                      <textarea
                        id="prop-allowed-tools"
                        value={(
                          (
                            properties.toolPermissions as
                              | ToolPermissionsOverride
                              | undefined
                          )?.allowedTools ?? []
                        ).join("\n")}
                        onChange={(e) => {
                          const current =
                            (properties.toolPermissions as
                              | ToolPermissionsOverride
                              | undefined) || {};
                          setProperty("toolPermissions", {
                            ...current,
                            allowedTools: e.target.value.split("\n"),
                          });
                        }}
                        disabled={allowedDisabled}
                        placeholder={"read\nglob\ngrep"}
                        className={`flex-1 min-h-[60px] w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border resize-none font-mono${
                          allowedDisabled
                            ? " opacity-50 cursor-not-allowed"
                            : ""
                        }`}
                      />
                    </div>

                    {/* Denied Tools */}
                    <div className="flex-1 flex flex-col gap-1 min-h-0">
                      <label
                        htmlFor="prop-denied-tools"
                        className="text-[11px] font-semibold uppercase text-description-fg"
                        title="Tool patterns to deny (one per line, takes precedence over allow list)."
                      >
                        Denied Tools
                      </label>
                      <textarea
                        id="prop-denied-tools"
                        value={(
                          (
                            properties.toolPermissions as
                              | ToolPermissionsOverride
                              | undefined
                          )?.deniedTools ?? []
                        ).join("\n")}
                        onChange={(e) => {
                          const current =
                            (properties.toolPermissions as
                              | ToolPermissionsOverride
                              | undefined) || {};
                          setProperty("toolPermissions", {
                            ...current,
                            deniedTools: e.target.value.split("\n"),
                          });
                        }}
                        disabled={deniedDisabled}
                        placeholder={"shell(rm:*)\nwrite"}
                        className={`flex-1 min-h-[60px] w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border resize-none font-mono${
                          deniedDisabled ? " opacity-50 cursor-not-allowed" : ""
                        }`}
                      />
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Page: Hooks */}
        {activePage === DRAWER_PAGES.HOOKS && (
          <div className="space-y-2">
            <label className="text-[11px] font-semibold uppercase text-description-fg">
              User Hooks
            </label>
            <HooksEditor
              value={properties.hooks}
              onChange={(v) => setProperty("hooks", v)}
              inheritedValue={resolvedHooks}
            />
          </div>
        )}
      </div>

      {/* Tab Bar */}
      <DrawerTabBar
        activeTab={activePage}
        onTabChange={setActivePage}
        harnessId={currentHarness}
        isNarrow={isNarrow}
      />
    </div>
  );
};
