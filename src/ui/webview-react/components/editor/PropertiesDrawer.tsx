import React, { useEffect, useState } from "react";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import {
  useEditorStore,
  END_CONDITION_DEFAULTS,
} from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import {
  HARNESS_IDS,
  type HarnessId,
  type PriorContext,
  type ToolPermissionsOverride,
  type ToolPermissionMode,
} from "../../types/messages";
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
import { DRAWER_PAGES, type DrawerPage } from "../../types/drawerPages";

/** Max height for dropdowns inside the PropertiesDrawer (px, not vh — the drawer has a fixed height). */
const DRAWER_DROPDOWN_MAX_HEIGHT = "150px";

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
  const { hiddenDropdownOptions, hideDropdownOption, unhideDropdownOption } =
    useUiStore();
  const prompts = useWorkflowStore((s) => s.prompts);
  const [drawerRef, isNarrow] = useElementNarrow<HTMLDivElement>(576);

  // Build prior prompt list for priorContext custom selection.
  const priorPrompts = (() => {
    const limit =
      selectedPromptIndex === null ? prompts.length : selectedPromptIndex;
    return prompts.slice(0, limit).map((p, i) => ({
      number: i + 1,
      name: p.name,
    }));
  })();

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

  // End condition expanded state
  const [endConditionExpanded, setEndConditionExpanded] = useState(
    !!properties.endCondition
  );

  // Sync expanded state when endCondition changes
  useEffect(() => {
    setEndConditionExpanded(!!properties.endCondition);
  }, [properties.endCondition]);

  // Reset to first page when drawer opens for a new prompt
  useEffect(() => {
    if (isOpen) {
      setActivePage(DRAWER_PAGES.HARNESS);
    }
  }, [isOpen, selectedPromptIndex]);

  // Get models for current harness
  const currentHarness = (properties.harness ??
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
      setEndConditionExpanded(false);
    } else {
      setEndCondition({ ...END_CONDITION_DEFAULTS });
      setEndConditionExpanded(true);
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
      <div className="drawer-body flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-2">
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
                  value={
                    properties.additionalArgs === undefined
                      ? "default"
                      : properties.additionalArgs === null
                        ? "none"
                        : "custom"
                  }
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
                {/* Narrow mode: input below the dropdown */}
                {isNarrow && (
                  <div
                    className={`transition-all duration-300 ${
                      typeof properties.additionalArgs === "string"
                        ? "max-h-[60px] opacity-100"
                        : "max-h-0 opacity-0 overflow-hidden"
                    }`}
                  >
                    <input
                      type="text"
                      id="prop-additional-args"
                      value={
                        typeof properties.additionalArgs === "string"
                          ? properties.additionalArgs
                          : ""
                      }
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
                  className={`flex flex-col justify-end transition-all duration-300 ${
                    typeof properties.additionalArgs === "string"
                      ? "opacity-100"
                      : "opacity-0 pointer-events-none"
                  }`}
                >
                  <input
                    type="text"
                    id="prop-additional-args-wide"
                    value={
                      typeof properties.additionalArgs === "string"
                        ? properties.additionalArgs
                        : ""
                    }
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
                {/* Session ID — expands directly below, no label */}
                <div
                  className={`transition-all duration-300 ${
                    properties.resumeSession === true &&
                    properties.sessionId !== SESSION_ID_SENTINELS.FINAL_PROMPT
                      ? "max-h-[60px] opacity-100"
                      : "max-h-0 opacity-0 overflow-hidden"
                  }`}
                >
                  <input
                    type="text"
                    id="prop-session-id"
                    value={properties.sessionId}
                    onChange={(e) => setProperty("sessionId", e.target.value)}
                    placeholder="Session ID or prompt number (e.g., 1)"
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
                  priorPrompts={priorPrompts}
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

              {/* End condition details (collapsible) */}
              <div
                className={`overflow-hidden transition-all duration-200 ${
                  endConditionExpanded && properties.endCondition
                    ? "max-h-[500px] opacity-100"
                    : "max-h-0 opacity-0"
                }`}
              >
                <div className="space-y-3 p-3 bg-editor-bg border border-panel-border rounded">
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
                        disabled={!properties.endCondition}
                        placeholder="npm test"
                        className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
                      />
                    </div>

                    {/* Returns */}
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
                        disabled={!properties.endCondition}
                        placeholder="true"
                        className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
                      />
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
                        disabled={!properties.endCondition}
                        min={1000}
                        max={300000}
                        className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
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
                        disabled={!properties.endCondition}
                        min={-1}
                        max={100}
                        className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50"
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
                      disabled={!properties.endCondition}
                      placeholder={
                        "Validation failed: {error}\n\nPlease fix the issues."
                      }
                      rows={3}
                      className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50 resize-y"
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
                      disabled={!properties.endCondition}
                      className="w-4 h-4 accent-focus-border cursor-pointer disabled:opacity-50"
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
            />
          </div>
        )}

        {/* Page: Permissions */}
        {activePage === DRAWER_PAGES.PERMISSIONS && (
          <>
            {/* Copilot Chat: not applicable */}
            {permHarnessSupport === "n/a" && (
              <p className="text-[10px] text-description-fg mb-2">
                ℹ️ Tool permissions apply to CLI harnesses only and are ignored
                for Copilot Chat.
              </p>
            )}

            <div
              className={`space-y-2${permHarnessSupport === "n/a" ? " opacity-60" : ""}`}
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
                        ? "none"
                        : (properties.toolPermissions.mode ?? "allowAll")
                  }
                  onChange={(v) => {
                    if (v === "default") {
                      setProperty("toolPermissions", undefined);
                    } else if (v === "none") {
                      setProperty("toolPermissions", null);
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
                    { value: "none", label: "None (passthrough)" },
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
                      ? "passthrough"
                      : (workflowProperties.toolPermissions?.mode ?? "allowAll")
                    : properties.toolPermissions === null
                      ? "passthrough"
                      : (properties.toolPermissions.mode ?? "allowAll");
                const isInheriting = properties.toolPermissions === undefined;
                const allowedDisabled =
                  isInheriting ||
                  permHarnessSupport === "mode-only" ||
                  effectivePermMode !== "custom";
                const deniedDisabled =
                  isInheriting ||
                  permHarnessSupport === "mode-only" ||
                  effectivePermMode === "dangerouslyAllowAll" ||
                  effectivePermMode === "passthrough";

                return (
                  <div className="space-y-2">
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
                    <div className="flex flex-col gap-1">
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
                        rows={4}
                        placeholder={"read\nglob\ngrep"}
                        className={`w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border resize-none font-mono${
                          allowedDisabled
                            ? " opacity-50 cursor-not-allowed"
                            : ""
                        }`}
                      />
                    </div>

                    {/* Denied Tools */}
                    <div className="flex flex-col gap-1">
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
                        rows={4}
                        placeholder={"shell(rm:*)\nwrite"}
                        className={`w-full px-2 py-1 text-xs bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border resize-none font-mono${
                          deniedDisabled ? " opacity-50 cursor-not-allowed" : ""
                        }`}
                      />
                    </div>
                  </div>
                );
              })()}
            </div>
          </>
        )}

        {/* Page: Hooks (placeholder) */}
        {activePage === DRAWER_PAGES.HOOKS && (
          <div className="flex items-center justify-center h-32 text-description-fg text-xs">
            Coming Soon
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
