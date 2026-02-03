import React from "react";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { Button } from "../shared";

export const SettingsDrawer: React.FC = () => {
  const { settingsDrawerOpen, toggleSettingsDrawer } = useUiStore();
  const { modelOptions, availableAgents } = useSettingsStore();
  const { fileName } = useWorkflowStore();

  const handleProviderChange = (provider: string) => {
    window.postMessage({
      type: "changeProvider",
      provider,
    });
  };

  const handleModelChange = (model: string) => {
    window.postMessage({
      type: "changeModel",
      model,
    });
  };

  const handleAgentChange = (agent: string) => {
    window.postMessage({
      type: "changeAgent",
      agent,
    });
  };

  const handleExecutionModeChange = (mode: string) => {
    window.postMessage({
      type: "changeExecutionMode",
      mode,
    });
  };

  const handleResumeSessionChange = (resume: boolean) => {
    window.postMessage({
      type: "changeResumeSession",
      resume,
    });
  };

  const handleOpenSettings = () => {
    window.postMessage({
      type: "openSettings",
    });
  };

  if (!settingsDrawerOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-80 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 shadow-lg z-40 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Settings
        </h2>
        <button
          onClick={toggleSettingsDrawer}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
          aria-label="Close settings"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Body - Scrollable */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {/* Workflow Properties Section */}
        <section>
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
            Workflow Properties
          </h3>
          <div className="space-y-4">
            {/* Provider Select */}
            <div>
              <label
                htmlFor="provider-select"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Provider
              </label>
              <select
                id="provider-select"
                onChange={(e) => handleProviderChange(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={!fileName}
              >
                <option value="copilot-cli">Copilot CLI</option>
                <option value="copilot-chat">Copilot Chat</option>
                <option value="claude-cli">Claude CLI</option>
                <option value="codex-cli">Codex CLI</option>
              </select>
            </div>

            {/* Model Select */}
            <div>
              <label
                htmlFor="model-select"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Model
              </label>
              <select
                id="model-select"
                onChange={(e) => handleModelChange(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={!fileName}
              >
                <option value="">Default</option>
                {Object.entries(modelOptions).map(([provider, models]) =>
                  models.map((model) => (
                    <option key={`${provider}-${model}`} value={model}>
                      {model}
                    </option>
                  ))
                )}
              </select>
            </div>

            {/* Agent Select */}
            <div>
              <label
                htmlFor="agent-select"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Agent
              </label>
              <select
                id="agent-select"
                onChange={(e) => handleAgentChange(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={!fileName}
              >
                <option value="">None</option>
                {availableAgents.map((agent) => (
                  <option key={agent.path} value={agent.path}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* Session Settings Section */}
        <section>
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
            Session Settings
          </h3>
          <div className="space-y-3">
            {/* Execution Mode */}
            <div className="flex items-center justify-between">
              <label
                htmlFor="execution-mode"
                className="text-xs font-medium text-gray-700 dark:text-gray-300"
              >
                Execution Mode
              </label>
              <select
                id="execution-mode"
                onChange={(e) => handleExecutionModeChange(e.target.value)}
                className="px-3 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="interactive">Interactive</option>
                <option value="headless">Headless</option>
              </select>
            </div>

            {/* Resume Session Toggle */}
            <div className="flex items-center justify-between">
              <label
                htmlFor="resume-session"
                className="text-xs font-medium text-gray-700 dark:text-gray-300"
              >
                Resume Session
              </label>
              <button
                id="resume-session"
                onClick={(e) => {
                  const isChecked =
                    (e.target as HTMLButtonElement).getAttribute(
                      "aria-checked"
                    ) === "true";
                  handleResumeSessionChange(!isChecked);
                  (e.target as HTMLButtonElement).setAttribute(
                    "aria-checked",
                    String(!isChecked)
                  );
                }}
                role="switch"
                aria-checked="false"
                className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 bg-gray-200 dark:bg-gray-700"
              >
                <span className="inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-1" />
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700">
        <Button
          variant="secondary"
          onClick={handleOpenSettings}
          className="w-full"
        >
          More Settings...
        </Button>
      </div>
    </div>
  );
};
