import React, { useEffect, useState } from "react";
import {
  useEditorStore,
  END_CONDITION_DEFAULTS,
} from "../../store/editorStore";
import { useSettingsStore } from "../../store/settingsStore";
import { PROVIDER_IDS, type ProviderId } from "../../types/messages";

interface PropertiesDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * PropertiesDrawer - Slide-up panel for prompt properties
 *
 * Features:
 * - Provider dropdown (from settingsStore)
 * - Model dropdown (dynamic based on provider)
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
  const { availableAgents, globalSettings, getModelsForProvider } =
    useSettingsStore();

  // End condition expanded state
  const [endConditionExpanded, setEndConditionExpanded] = useState(
    !!properties.endCondition
  );

  // Sync expanded state when endCondition changes
  useEffect(() => {
    setEndConditionExpanded(!!properties.endCondition);
  }, [properties.endCondition]);

  // Get models for current provider
  const currentProvider =
    properties.provider === "default"
      ? globalSettings.provider
      : (properties.provider as ProviderId);
  const models = getModelsForProvider(currentProvider);

  // Handle provider change - also reset model to default
  const handleProviderChange = (newProvider: string) => {
    setProperty("provider", newProvider);
    // Reset model when provider changes
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
      className={`properties-drawer absolute bottom-0 left-[1px] right-[1px] bg-[var(--vscode-sideBar-background)] border-t-2 border-[var(--vscode-panel-border)] shadow-lg transition-transform duration-300 z-[100] max-h-full flex flex-col ${
        isOpen ? "translate-y-[2px]" : "translate-y-full"
      }`}
    >
      {/* Drawer Content */}
      <div className="drawer-content flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="drawer-header flex items-center justify-between px-4 py-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-dropBackground)] sticky top-0 z-10">
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
            {/* Provider */}
            <div className="prop-group">
              <label
                htmlFor="prop-provider"
                className="prop-label block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
              >
                Provider
              </label>
              <select
                id="prop-provider"
                value={properties.provider}
                onChange={(e) => handleProviderChange(e.target.value)}
                className="prop-select w-full px-2 py-1 text-sm bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
              >
                <option value="default">Default</option>
                <option value={PROVIDER_IDS.COPILOT_CLI}>Copilot CLI</option>
                <option value={PROVIDER_IDS.COPILOT_CHAT}>Copilot Chat</option>
                <option value={PROVIDER_IDS.CLAUDE_CLI}>Claude CLI</option>
                <option value={PROVIDER_IDS.CODEX_CLI}>Codex CLI</option>
              </select>
            </div>

            {/* Model */}
            <div className="prop-group">
              <label
                htmlFor="prop-model"
                className="prop-label block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
              >
                Model
              </label>
              <select
                id="prop-model"
                value={properties.model}
                onChange={(e) => setProperty("model", e.target.value)}
                className="prop-select w-full px-2 py-1 text-sm bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
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

            {/* Agent */}
            <div className="prop-group">
              <label
                htmlFor="prop-agent"
                className="prop-label block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
              >
                Agent
              </label>
              <select
                id="prop-agent"
                value={properties.agent}
                onChange={(e) => setProperty("agent", e.target.value)}
                className="prop-select w-full px-2 py-1 text-sm bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
              >
                <option value="">None</option>
                {availableAgents.map((agent) => (
                  <option key={agent.path} value={agent.path}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Resume Session */}
            <div className="prop-group">
              <label
                htmlFor="prop-resume-session"
                className="prop-label block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
              >
                Resume Session
              </label>
              <select
                id="prop-resume-session"
                value={properties.resumeSession}
                onChange={(e) => setProperty("resumeSession", e.target.value)}
                className="prop-select w-full px-2 py-1 text-sm bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
              >
                <option value="default">Default</option>
                <option value="yes">Yes - Resume previous session</option>
                <option value="no">No - Start new session</option>
              </select>
            </div>

            {/* Session ID (enabled only when resume session is "yes") */}
            <div className="prop-group">
              <label
                htmlFor="prop-session-id"
                className="prop-label block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
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
                className="prop-input w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
              />
            </div>

            {/* Allow Dynamic Extension */}
            <div className="prop-group">
              <label
                htmlFor="prop-allow-dynamic"
                className="prop-label block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
              >
                Allow Dynamic Extension
              </label>
              <select
                id="prop-allow-dynamic"
                value={properties.allowDynamicExtension}
                onChange={(e) =>
                  setProperty("allowDynamicExtension", e.target.value)
                }
                className="prop-select w-full px-2 py-1 text-sm bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
              >
                <option value="default">Default</option>
                <option value="yes">Yes - Allow AI to extend workflow</option>
                <option value="no">No - Disable dynamic extension</option>
              </select>
            </div>

            {/* End Condition Section */}
            <div className="prop-group">
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  id="prop-end-enabled"
                  checked={!!properties.endCondition}
                  onChange={handleEndConditionToggle}
                  className="w-4 h-4 rounded border-[var(--vscode-input-border)]"
                />
                <label
                  htmlFor="prop-end-enabled"
                  className="prop-label text-xs font-medium text-[var(--vscode-foreground)]"
                >
                  Enable End Condition
                </label>
              </div>

              {/* End condition details (collapsible) */}
              <div
                className={`prop-end-details space-y-3 pl-6 overflow-hidden transition-all duration-200 ${
                  endConditionExpanded && properties.endCondition
                    ? "max-h-[500px] opacity-100"
                    : "max-h-0 opacity-0"
                }`}
              >
                {/* Script */}
                <div>
                  <label
                    htmlFor="prop-end-script"
                    className="prop-label block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
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
                    className="prop-input w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
                  />
                </div>

                {/* Returns */}
                <div>
                  <label
                    htmlFor="prop-end-returns"
                    className="prop-label block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
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
                    className="prop-input w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
                  />
                </div>

                {/* Timeout */}
                <div>
                  <label
                    htmlFor="prop-end-timeout"
                    className="prop-label block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
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
                    className="prop-input w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
                  />
                </div>

                {/* Max Retries */}
                <div>
                  <label
                    htmlFor="prop-end-retries"
                    className="prop-label block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
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
                    className="prop-input w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
                  />
                  <span className="text-[10px] text-[var(--vscode-descriptionForeground)]">
                    Use -1 for unlimited retries
                  </span>
                </div>

                {/* Retry Prompt */}
                <div>
                  <label
                    htmlFor="prop-end-retry-prompt"
                    className="prop-label block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
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
                    className="prop-input w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50 resize-y"
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
  );
};
