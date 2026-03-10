import React, { useEffect, useRef, useState } from "react";
import {
  useEditorStore,
  END_CONDITION_DEFAULTS,
} from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { type HarnessId } from "../../types/messages";
import {
  DROPDOWN_NAMESPACES,
  modelNamespaceForHarness,
} from "../../types/dropdownNamespaces";
import {
  CustomSelect,
  HarnessDropdown,
  HARNESS_DISPLAY_NAMES,
  harnessCategory,
  PriorContextSelect,
} from "../shared";

/** Max height for dropdowns inside the PropertiesDrawer (px, not vh — the drawer has a fixed height). */
const DRAWER_DROPDOWN_MAX_HEIGHT = "150px";

interface PropertiesDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * SkillsSelect — Hybrid dropdown for the prompt-level skills property.
 *
 * Top section: "Default (X)" and "None" keywords where X is the resolved inherited value.
 * Below a divider: checkbox list of available skills.
 * Selecting a keyword clears the array selection; toggling checkboxes
 * switches to custom array mode (matching the PriorContextSelect pattern).
 */
const SkillsSelect: React.FC<{
  value: string[] | null | undefined;
  onChange: (v: string[] | null | undefined) => void;
  availableSkills: Array<{ name: string; description?: string }>;
  defaultLabel?: string;
  dropdownMaxHeight?: string;
}> = ({ value, onChange, availableSkills, defaultLabel, dropdownMaxHeight = "60vh" }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
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

  const selectedSkills = Array.isArray(value) ? value : [];

  let buttonLabel: string;
  if (value === undefined) {
    buttonLabel = defaultLabel ?? "Default";
  } else if (value === null) {
    buttonLabel = "None";
  } else if (selectedSkills.length === 0) {
    buttonLabel = "None selected";
  } else if (selectedSkills.length <= 2) {
    buttonLabel = selectedSkills.join(", ");
  } else {
    buttonLabel = `${selectedSkills.slice(0, 2).join(", ")} +${selectedSkills.length - 2}`;
  }

  const toggleSkill = (name: string) => {
    const current = Array.isArray(value) ? value : [];
    const updated = current.includes(name)
      ? current.filter((s) => s !== name)
      : [...current, name];
    onChange(updated);
  };

  return (
    <div className="relative inline-block w-full" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full px-2 py-1 text-xs bg-dropdown-bg text-dropdown-fg border border-dropdown-border rounded focus:outline-none focus:border-focus-border text-left flex items-center justify-between h-7"
      >
        <span className="truncate">{buttonLabel}</span>
        <i
          className={`codicon codicon-chevron-${isOpen ? "up" : "down"} text-[10px] flex-shrink-0 ml-1`}
        />
      </button>

      <div
        className={`absolute top-full left-0 right-0 mt-0 bg-dropdown-bg border border-dropdown-border z-50 shadow-lg transition-all duration-150 origin-top flex flex-col ${
          isOpen
            ? "opacity-100 translate-y-0 visible"
            : "opacity-0 -translate-y-1 invisible pointer-events-none"
        }`}
        style={{ maxHeight: dropdownMaxHeight }}
      >
        <div className="overflow-y-auto min-h-0 flex-1">
          {/* Keyword options */}
          {(["default", "none"] as const).map((k) => {
            const isSelected =
              k === "default" ? value === undefined : value === null;
            const label =
              k === "default" ? (defaultLabel ?? "Default") : "None";
            return (
              <button
                key={k}
                type="button"
                onClick={() => {
                  onChange(k === "default" ? undefined : null);
                  setIsOpen(false);
                }}
                className={`w-full px-2 py-1.5 text-xs text-left flex items-center gap-2 focus:outline-none border-none ${
                  isSelected
                    ? "bg-dropdown-selected-bg text-list-active-fg"
                    : "hover:bg-list-hover-bg cursor-pointer"
                }`}
              >
                <i
                  className={`codicon codicon-check text-[10px] flex-shrink-0 ${
                    isSelected ? "visible" : "invisible"
                  }`}
                />
                <span>{label}</span>
              </button>
            );
          })}

          {/* Skills checkbox section */}
          {availableSkills.length > 0 && (
            <>
              <div className="border-t border-dropdown-border" />
              <div className="px-2 py-1 text-[10px] text-description-fg uppercase font-semibold tracking-wide">
                Select skills:
              </div>
              {availableSkills.map((skill) => {
                const isChecked = selectedSkills.includes(skill.name);
                return (
                  <button
                    key={skill.name}
                    type="button"
                    onClick={() => toggleSkill(skill.name)}
                    className={`w-full px-2 py-1.5 text-xs text-left flex items-start gap-2 focus:outline-none border-none ${
                      isChecked
                        ? "bg-dropdown-selected-bg text-list-active-fg"
                        : "hover:bg-list-hover-bg cursor-pointer"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {}}
                      className="mt-0.5 w-3 h-3 flex-shrink-0 accent-focus-border cursor-pointer"
                      tabIndex={-1}
                    />
                    <span className="flex flex-col min-w-0">
                      <span className="font-medium truncate">{skill.name}</span>
                      {skill.description && (
                        <span className="text-[10px] text-description-fg truncate">
                          {skill.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

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

  const resolvedHarness = (workflowProperties.harness ?? globalSettings.harness) as HarnessId;
  const defaultHarnessLabel = `Default (${HARNESS_DISPLAY_NAMES[resolvedHarness] ?? resolvedHarness})`;

  const resolvedModels = getModelsForHarness(resolvedHarness);
  const resolvedModelValue =
    workflowProperties.model ??
    globalSettings.harnessDefaultModels[resolvedHarness] ??
    globalSettings.model;
  const resolvedModelLabel =
    resolvedModels.find((m) => m.value === resolvedModelValue)?.label ?? resolvedModelValue;
  const defaultModelLabel = `Default (${resolvedModelLabel || "None"})`;

  const resolvedAgent =
    workflowProperties.agent === undefined
      ? globalSettings.agent
      : workflowProperties.agent;
  const resolvedAgentName =
    !resolvedAgent
      ? "None"
      : (availableAgents.find((a) => a.path === resolvedAgent || a.name === resolvedAgent)?.name ??
          resolvedAgent);
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
  const defaultAdditionalArgsLabel =
    !resolvedAdditionalArgs ? "Default (None)" : `Default (${resolvedAdditionalArgs})`;

  const resolvedResumeSession =
    workflowProperties.resumeSession ?? globalSettings.resumeSession;
  const defaultResumeSessionLabel = `Default (${resolvedResumeSession ? "Yes" : "No"})`;

  const resolvedAllowDynamic =
    workflowProperties.allowDynamicExtension ?? globalSettings.allowDynamicExtension;
  const defaultAllowDynamicLabel = `Default (${resolvedAllowDynamic ? "Yes" : "No"})`;

  // End condition expanded state
  const [endConditionExpanded, setEndConditionExpanded] = useState(
    !!properties.endCondition
  );

  // Sync expanded state when endCondition changes
  useEffect(() => {
    setEndConditionExpanded(!!properties.endCondition);
  }, [properties.endCondition]);

  // Get models for current harness
  const currentHarness = (
    properties.harness ?? globalSettings.harness
  ) as HarnessId;
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
      className={`properties-drawer absolute bottom-0 left-0 right-0 bg-sidebar-bg border-t-2 border-panel-border shadow-lg transition-transform duration-300 z-[100] max-h-full flex flex-col overflow-hidden ${
        isOpen ? "translate-y-0" : "translate-y-full"
      }`}
    >
      {/* Header */}
      <div className="drawer-header shrink-0 flex items-center justify-between px-4 py-0 border-b border-panel-border bg-sidebar-drop-bg z-10">
        <h3 className="text-xs font-semibold text-foreground uppercase">
          Prompt Properties
        </h3>
        <button
          className="btn-close-drawer w-7 h-7 flex items-center justify-center rounded opacity-70 hover:opacity-100 hover:bg-toolbar-hover-bg transition-all"
          onClick={onClose}
          title="Close properties drawer"
        >
          <i className="codicon codicon-close" />
        </button>
      </div>

      {/* Body */}
      <div className="drawer-body flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4">
        <div className="space-y-4">
          {/* Row 1: Harness + Model */}
          <div className="grid grid-cols-2 gap-4">
            {/* Harness */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-harness"
                className="text-xs font-medium text-foreground"
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
                className="text-xs font-medium text-foreground"
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
          </div>

          {/* Row 2: Agent + Skills */}
          <div className="grid grid-cols-2 gap-4">
            {/* Agent — single flat dropdown: Default / None / each agent */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-agent"
                className="text-xs font-medium text-foreground"
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
                nonHideableValues={["default", "none"]}
                dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
              />
            </div>

            {/* Skills — hybrid dropdown with Default/None keywords + checkbox list */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-skills"
                className="text-xs font-medium text-foreground"
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
          </div>

          {/* Row 3: Additional Args + Resume Session (with paired Session ID) */}
          <div className="grid grid-cols-2 gap-4">
            {/* Additional Args — mode select + paired text input */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-additional-args-mode"
                className="text-xs font-medium text-foreground"
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
            </div>

            {/* Resume Session — paired control with Session ID below */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-resume-session"
                className="text-xs font-medium text-foreground"
              >
                Resume Session
              </label>
              <CustomSelect
                id="prop-resume-session"
                value={
                  properties.resumeSession === undefined
                    ? "default"
                    : properties.resumeSession
                      ? "yes"
                      : "no"
                }
                onChange={(v) =>
                  setProperty(
                    "resumeSession",
                    v === "default" ? undefined : v === "yes"
                  )
                }
                options={[
                  { value: "default", label: defaultResumeSessionLabel },
                  { value: "yes", label: "Yes - Resume previous" },
                  { value: "no", label: "No - New session" },
                ]}
                dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
              />
              {/* Session ID — expands directly below, no label */}
              <div
                className={`transition-all duration-300 ${
                  properties.resumeSession === true
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
          </div>

          {/* Row 4: Prior Context + Allow Dynamic Extension */}
          <div className="grid grid-cols-2 gap-4">
            {/* Prior Context */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-prior-context"
                className="text-xs font-medium text-foreground"
                title="Inject prior prompt outputs into this prompt's text before sending to the AI"
              >
                Prior Context
              </label>
              <PriorContextSelect
                id="prop-prior-context"
                value={properties.priorContext}
                onChange={(v) => setProperty("priorContext", v)}
                showDefault
                priorPrompts={priorPrompts}
                dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
              />
            </div>

            {/* Allow Dynamic Extension */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-allow-dynamic"
                className="text-xs font-medium text-foreground"
              >
                Allow Dynamic Ext.
              </label>
              <CustomSelect
                id="prop-allow-dynamic"
                value={
                  properties.allowDynamicExtension === undefined
                    ? "default"
                    : properties.allowDynamicExtension
                      ? "yes"
                      : "no"
                }
                onChange={(v) =>
                  setProperty(
                    "allowDynamicExtension",
                    v === "default" ? undefined : v === "yes"
                  )
                }
                options={[
                  { value: "default", label: defaultAllowDynamicLabel },
                  { value: "yes", label: "Yes - Allow AI to extend" },
                  { value: "no", label: "No - Disable" },
                ]}
                dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
              />
            </div>
          </div>

          {/* End Condition Section (Full Width) */}
          <div className="border-t border-panel-border pt-4 mt-4">
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
                {/* Row 1: Script + Returns */}
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

                {/* Row 2: Timeout + Max Retries */}
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

                {/* Row 3: Retry Prompt (Full Width) */}
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
                    placeholder={"Validation failed: {error}\n\nPlease fix the issues."}
                    rows={3}
                    className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50 resize-y"
                  />
                  <span className="text-[10px] text-description-fg">
                    Use {"{error}"} placeholder for validation error message
                  </span>
                </div>

                {/* Row 4: Resume Session on Retry */}
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
      </div>
    </div>
  );
};
