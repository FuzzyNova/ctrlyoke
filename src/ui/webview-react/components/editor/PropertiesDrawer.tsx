import React, { useEffect, useState } from "react";
import {
  useEditorStore,
  END_CONDITION_DEFAULTS,
} from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { type HarnessId } from "../../types/messages";
import {
  DROPDOWN_NAMESPACES,
  modelNamespaceForHarness,
} from "../../types/dropdownNamespaces";
import {
  CustomSelect,
  MultiCheckboxDropdown,
  HarnessDropdown,
  harnessCategory,
} from "../shared";

/** Max height for dropdowns inside the PropertiesDrawer (px, not vh — the drawer has a fixed height). */
const DRAWER_DROPDOWN_MAX_HEIGHT = "150px";

interface PropertiesDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * PropertiesDrawer - Slide-up panel for prompt properties
 *
 * Features:
 * - Harness dropdown (from settingsStore)
 * - Model dropdown (dynamic based on harness)
 * - Agent dropdown
 * - Resume Session dropdown and Session ID input
 * - Allow Dynamic Extension dropdown
 * - End Condition section (collapsible)
 *   - Enable checkbox
 *   - Script, Returns, Timeout, Max Retries, Retry Prompt fields
 */
export const PropertiesDrawer: React.FC<PropertiesDrawerProps> = ({
  isOpen,
  onClose,
}) => {
  const {
    properties,
    setProperty,
    setEndCondition,
    updateEndConditionField,
    clearEndCondition,
  } = useEditorStore();
  const {
    availableAgents,
    availableSkills,
    globalSettings,
    getModelsForHarness: getModelsForHarness,
  } = useSettingsStore();
  const { hiddenDropdownOptions, hideDropdownOption, unhideDropdownOption } =
    useUiStore();

  // End condition expanded state
  const [endConditionExpanded, setEndConditionExpanded] = useState(
    !!properties.endCondition
  );

  // Sync expanded state when endCondition changes
  useEffect(() => {
    setEndConditionExpanded(!!properties.endCondition);
  }, [properties.endCondition]);

  // Get models for current harness
  const currentHarness =
    properties.harness === "default"
      ? globalSettings.harness
      : (properties.harness as HarnessId);
  const models = getModelsForHarness(currentHarness);
  const modelNamespace = modelNamespaceForHarness(currentHarness);

  // Handle harness change - also reset model to default
  const handleHarnessChange = (newHarness: string) => {
    setProperty("harness", newHarness);
    // Reset model when harness changes
    setProperty("model", "default");
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
                {`Harness${harnessCategory(properties.harness) === "cli" ? " (CLI)" : harnessCategory(properties.harness) === "chat" ? " (Chat)" : ""}`}
              </label>
              <HarnessDropdown
                id="prop-harness"
                value={properties.harness}
                onChange={handleHarnessChange}
                showDefault={true}
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
                value={properties.model}
                onChange={(v) => setProperty("model", v)}
                options={[
                  { value: "default", label: "Default" },
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
                onUnhideOption={(v) => unhideDropdownOption(modelNamespace, v)}
                nonHideableValues={["default", ""]}
                dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
              />
            </div>
          </div>

          {/* Row 2: Agent + Skills */}
          <div className="grid grid-cols-2 gap-4">
            {/* Agent */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-agent"
                className="text-xs font-medium text-foreground"
              >
                Agent
              </label>
              <CustomSelect
                id="prop-agent"
                value={properties.agent}
                onChange={(v) => setProperty("agent", v)}
                options={[
                  { value: "", label: "None" },
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
                dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
              />
            </div>

            {/* Skills */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-skills"
                className="text-xs font-medium text-foreground"
              >
                Skills
              </label>
              <MultiCheckboxDropdown
                id="prop-skills"
                selectedValues={properties.skills}
                onChange={(v) => setProperty("skills", v)}
                options={availableSkills.map((s) => ({
                  value: s.name,
                  label: s.name,
                  description: s.description || undefined,
                }))}
                placeholder="None (inherit from workflow)"
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
                dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
              />
              {properties.skills.length > 0 && (
                <p className="text-[10px] text-description-fg">
                  Active: {properties.skills.join(", ")}
                </p>
              )}
            </div>
          </div>

          {/* Row 3: Allow Dynamic Extension + Resume Session */}
          <div className="grid grid-cols-2 gap-4">
            {/* Allow Dynamic Extension */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-allow-dynamic"
                className="text-xs font-medium text-foreground"
              >
                Allow Dynamic Extension
              </label>
              <CustomSelect
                id="prop-allow-dynamic"
                value={properties.allowDynamicExtension}
                onChange={(v) => setProperty("allowDynamicExtension", v)}
                options={[
                  { value: "default", label: "Default" },
                  {
                    value: "yes",
                    label: "Yes - Allow AI to extend workflow",
                  },
                  { value: "no", label: "No - Disable dynamic extension" },
                ]}
                dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
              />
            </div>

            {/* Resume Session */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-resume-session"
                className="text-xs font-medium text-foreground"
              >
                Resume Session
              </label>
              <CustomSelect
                id="prop-resume-session"
                value={properties.resumeSession}
                onChange={(v) => setProperty("resumeSession", v)}
                options={[
                  { value: "default", label: "Default" },
                  { value: "yes", label: "Yes - Resume previous session" },
                  { value: "no", label: "No - Start new session" },
                ]}
                dropdownMaxHeight={DRAWER_DROPDOWN_MAX_HEIGHT}
              />
            </div>
          </div>

          {/* Row 4: Session ID (full width, animated, visible only when resume session is "yes") */}
          <div
            className={`transition-all duration-300 ${
              properties.resumeSession === "yes"
                ? "max-h-[60px] opacity-100"
                : "max-h-0 opacity-0 overflow-hidden"
            }`}
          >
            <div className="flex flex-col gap-1">
              <label
                htmlFor="prop-session-id"
                className="text-xs font-medium text-foreground"
              >
                Session ID
              </label>
              <input
                type="text"
                id="prop-session-id"
                value={properties.sessionId}
                onChange={(e) => setProperty("sessionId", e.target.value)}
                placeholder="Enter session ID or prompt number (e.g., 1, 2)"
                className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border"
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
                    placeholder="Validation failed: {error}&#10;&#10;Please fix the issues."
                    rows={3}
                    className="px-2 py-1 text-sm bg-input-bg text-input-fg border border-input-border rounded focus:outline-none focus:border-focus-border disabled:opacity-50 resize-y"
                  />
                  <span className="text-[10px] text-description-fg">
                    Use {"{error}"} placeholder for validation error message
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
