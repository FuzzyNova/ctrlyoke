import React, { useEffect, useState } from "react";
import {
  useEditorStore,
  END_CONDITION_DEFAULTS,
} from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { HARNESS_IDS, type HarnessId } from "../../types/messages";

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
    globalSettings,
    getModelsForHarness: getModelsForHarness,
  } = useSettingsStore();

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
      className={`properties-drawer absolute bottom-0 left-0 right-0 bg-[var(--vscode-sideBar-background)] border-t-2 border-[var(--vscode-panel-border)] shadow-lg transition-transform duration-300 z-[100] max-h-full flex flex-col ${
        isOpen ? "translate-y-0" : "translate-y-full"
      }`}
    >
      {/* Drawer Content */}
      <div className="drawer-content flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="drawer-header flex items-center justify-between px-4 py-1 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-dropBackground)] sticky top-0 z-10">
          <h3 className="text-xs font-semibold text-[var(--vscode-foreground)] uppercase">
            Prompt Properties
          </h3>
          <button
            className="btn-close-drawer w-7 h-7 flex items-center justify-center rounded opacity-70 hover:opacity-100 hover:bg-[var(--vscode-toolbar-hoverBackground)] transition-all"
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
                  className="text-xs font-medium text-[var(--vscode-foreground)]"
                >
                  Harness
                </label>
                <select
                  id="prop-harness"
                  value={properties.harness}
                  onChange={(e) => handleHarnessChange(e.target.value)}
                  className="px-2 py-1 text-sm bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                >
                  <option value="default">Default</option>
                  <option value={HARNESS_IDS.COPILOT_CLI}>Copilot CLI</option>
                  <option value={HARNESS_IDS.COPILOT_CHAT}>Copilot Chat</option>
                  <option value={HARNESS_IDS.CLAUDE_CLI}>Claude CLI</option>
                  <option value={HARNESS_IDS.CODEX_CLI}>Codex CLI</option>
                </select>
              </div>

              {/* Model */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-model"
                  className="text-xs font-medium text-[var(--vscode-foreground)]"
                >
                  Model
                </label>
                <select
                  id="prop-model"
                  value={properties.model}
                  onChange={(e) => setProperty("model", e.target.value)}
                  className="px-2 py-1 text-sm bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                >
                  <option value="default">Default</option>
                  {models.length === 0 ? (
                    <option value="" disabled>
                      Loading models...
                    </option>
                  ) : (
                    models.map((model) => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>

            {/* Row 2: Agent + Allow Dynamic Extension (full width) */}
            <div className="grid grid-cols-2 gap-4">
              {/* Agent */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-agent"
                  className="text-xs font-medium text-[var(--vscode-foreground)]"
                >
                  Agent
                </label>
                <select
                  id="prop-agent"
                  value={properties.agent}
                  onChange={(e) => setProperty("agent", e.target.value)}
                  className="px-2 py-1 text-sm bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                >
                  <option value="">None</option>
                  {availableAgents.map((agent) => (
                    <option key={agent.path} value={agent.path}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Allow Dynamic Extension */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-allow-dynamic"
                  className="text-xs font-medium text-[var(--vscode-foreground)]"
                >
                  Allow Dynamic Extension
                </label>
                <select
                  id="prop-allow-dynamic"
                  value={properties.allowDynamicExtension}
                  onChange={(e) =>
                    setProperty("allowDynamicExtension", e.target.value)
                  }
                  className="px-2 py-1 text-sm bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                >
                  <option value="default">Default</option>
                  <option value="yes">Yes - Allow AI to extend workflow</option>
                  <option value="no">No - Disable dynamic extension</option>
                </select>
              </div>
            </div>

            {/* Row 3: Resume Session + Session ID */}
            <div className="grid grid-cols-2 gap-4">
              {/* Resume Session */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-resume-session"
                  className="text-xs font-medium text-[var(--vscode-foreground)]"
                >
                  Resume Session
                </label>
                <select
                  id="prop-resume-session"
                  value={properties.resumeSession}
                  onChange={(e) => setProperty("resumeSession", e.target.value)}
                  className="px-2 py-1 text-sm bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
                >
                  <option value="default">Default</option>
                  <option value="yes">Yes - Resume previous session</option>
                  <option value="no">No - Start new session</option>
                </select>
              </div>

              {/* Session ID (enabled only when resume session is "yes") */}
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="prop-session-id"
                  className="text-xs font-medium text-[var(--vscode-foreground)]"
                >
                  Session ID
                </label>
                <input
                  type="text"
                  id="prop-session-id"
                  value={properties.sessionId}
                  onChange={(e) => setProperty("sessionId", e.target.value)}
                  disabled={properties.resumeSession !== "yes"}
                  placeholder={
                    properties.resumeSession !== "yes"
                      ? "Enable Resume Session to input session ID"
                      : "Enter session ID or prompt number (e.g., 1, 2)"
                  }
                  className="px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
                />
              </div>
            </div>

            {/* End Condition Section (Full Width) */}
            <div className="border-t border-[var(--vscode-panel-border)] pt-4 mt-4">
              <div className="flex items-center gap-2 mb-3">
                <input
                  type="checkbox"
                  id="prop-end-enabled"
                  checked={!!properties.endCondition}
                  onChange={handleEndConditionToggle}
                  className="w-4 h-4 rounded border border-[var(--vscode-input-border)]"
                />
                <label
                  htmlFor="prop-end-enabled"
                  className="text-xs font-medium text-[var(--vscode-foreground)] cursor-pointer"
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
                <div className="space-y-3 p-3 bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] rounded">
                  {/* Row 1: Script + Returns */}
                  <div className="grid grid-cols-2 gap-3">
                    {/* Script */}
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor="prop-end-script"
                        className="text-xs font-medium text-[var(--vscode-foreground)]"
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
                        className="px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
                      />
                    </div>

                    {/* Returns */}
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor="prop-end-returns"
                        className="text-xs font-medium text-[var(--vscode-foreground)]"
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
                        className="px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
                      />
                    </div>
                  </div>

                  {/* Row 2: Timeout + Max Retries */}
                  <div className="grid grid-cols-2 gap-3">
                    {/* Timeout */}
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor="prop-end-timeout"
                        className="text-xs font-medium text-[var(--vscode-foreground)]"
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
                        className="px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
                      />
                    </div>

                    {/* Max Retries */}
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor="prop-end-retries"
                        className="text-xs font-medium text-[var(--vscode-foreground)]"
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
                        className="px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
                      />
                      <span className="text-[10px] text-[var(--vscode-descriptionForeground)]">
                        Use -1 for unlimited retries
                      </span>
                    </div>
                  </div>

                  {/* Row 3: Retry Prompt (Full Width) */}
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="prop-end-retry-prompt"
                      className="text-xs font-medium text-[var(--vscode-foreground)]"
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
                      className="px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50 resize-y"
                    />
                    <span className="text-[10px] text-[var(--vscode-descriptionForeground)]">
                      Use {"{error}"} placeholder for validation error message
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
