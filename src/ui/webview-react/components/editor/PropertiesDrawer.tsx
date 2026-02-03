import React, { useState } from "react";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { Collapsible } from "../shared";

export const PropertiesDrawer: React.FC = () => {
  const { selectedPromptIndex, originalPromptData } = useEditorStore();
  const { modelOptions, availableAgents } = useSettingsStore();

  // Local state for form controls
  const [provider, setProvider] = useState<string>(
    originalPromptData?.provider || "copilot-cli"
  );
  const [model, setModel] = useState<string>(originalPromptData?.model || "");
  const [agent, setAgent] = useState<string>(originalPromptData?.agent || "");
  const [resumeSession, setResumeSession] = useState<boolean>(
    originalPromptData?.resumeSession ?? false
  );
  const [sessionId, setSessionId] = useState<string>(
    originalPromptData?.sessionId || ""
  );
  const [allowDynamicExtension, setAllowDynamicExtension] = useState<boolean>(
    originalPromptData?.allowDynamicExtension ?? false
  );

  // End condition state
  const [hasEndCondition, setHasEndCondition] = useState<boolean>(
    !!originalPromptData?.endCondition
  );
  const [endConditionScript, setEndConditionScript] = useState<string>(
    originalPromptData?.endCondition?.script || ""
  );
  const [endConditionReturns, setEndConditionReturns] = useState<string>(
    originalPromptData?.endCondition?.returns || ""
  );
  const [endConditionTimeout, setEndConditionTimeout] = useState<number>(
    originalPromptData?.endCondition?.timeout || 30000
  );
  const [endConditionMaxRetries, setEndConditionMaxRetries] = useState<number>(
    originalPromptData?.endCondition?.maxRetries ?? 0
  );
  const [endConditionRetryPrompt, setEndConditionRetryPrompt] =
    useState<string>(originalPromptData?.endCondition?.retryPrompt || "");

  // Update local state when originalPromptData changes
  React.useEffect(() => {
    if (originalPromptData) {
      setProvider(originalPromptData.provider || "copilot-cli");
      setModel(originalPromptData.model || "");
      setAgent(originalPromptData.agent || "");
      setResumeSession(originalPromptData.resumeSession ?? false);
      setSessionId(originalPromptData.sessionId || "");
      setAllowDynamicExtension(
        originalPromptData.allowDynamicExtension ?? false
      );

      setHasEndCondition(!!originalPromptData.endCondition);
      if (originalPromptData.endCondition) {
        setEndConditionScript(originalPromptData.endCondition.script || "");
        setEndConditionReturns(originalPromptData.endCondition.returns || "");
        setEndConditionTimeout(
          originalPromptData.endCondition.timeout || 30000
        );
        setEndConditionMaxRetries(
          originalPromptData.endCondition.maxRetries ?? 0
        );
        setEndConditionRetryPrompt(
          originalPromptData.endCondition.retryPrompt || ""
        );
      }
    }
  }, [originalPromptData]);

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    sendUpdate({ provider: newProvider });
  };

  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    sendUpdate({ model: newModel });
  };

  const handleAgentChange = (newAgent: string) => {
    setAgent(newAgent);
    sendUpdate({ agent: newAgent });
  };

  const handleResumeSessionChange = (resume: boolean) => {
    setResumeSession(resume);
    sendUpdate({ resumeSession: resume });
  };

  const handleSessionIdChange = (id: string) => {
    setSessionId(id);
    sendUpdate({ sessionId: id });
  };

  const handleAllowDynamicExtensionChange = (allow: boolean) => {
    setAllowDynamicExtension(allow);
    sendUpdate({ allowDynamicExtension: allow });
  };

  const handleEndConditionChange = () => {
    const endCondition = hasEndCondition
      ? {
          script: endConditionScript,
          returns: endConditionReturns,
          timeout: endConditionTimeout,
          maxRetries: endConditionMaxRetries,
          retryPrompt: endConditionRetryPrompt,
        }
      : null;

    sendUpdate({ endCondition });
  };

  const sendUpdate = (updates: any) => {
    if (selectedPromptIndex === null) return;

    window.postMessage({
      type: "updatePrompt",
      index: selectedPromptIndex,
      ...updates,
    });
  };

  if (selectedPromptIndex === null) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <div className="text-center">
          <i className="codicon codicon-info text-2xl text-[var(--vscode-descriptionForeground)] mb-2"></i>
          <p className="text-sm text-[var(--vscode-descriptionForeground)]">
            Select a prompt to edit its properties
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 space-y-4">
      {/* Provider */}
      <div>
        <label
          htmlFor="provider-select"
          className="block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
        >
          Provider
        </label>
        <select
          id="provider-select"
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
        >
          <option value="copilot-cli">Copilot CLI</option>
          <option value="copilot-chat">Copilot Chat</option>
          <option value="claude-cli">Claude CLI</option>
          <option value="codex-cli">Codex CLI</option>
        </select>
      </div>

      {/* Model */}
      <div>
        <label
          htmlFor="model-select"
          className="block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
        >
          Model
        </label>
        <select
          id="model-select"
          value={model}
          onChange={(e) => handleModelChange(e.target.value)}
          className="w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
        >
          <option value="">Default</option>
          {Object.entries(modelOptions).map(([providerKey, models]) =>
            (models as string[]).map((m) => (
              <option key={`${providerKey}-${m}`} value={m}>
                {m}
              </option>
            ))
          )}
        </select>
      </div>

      {/* Agent */}
      <div>
        <label
          htmlFor="agent-select"
          className="block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
        >
          Agent
        </label>
        <select
          id="agent-select"
          value={agent}
          onChange={(e) => handleAgentChange(e.target.value)}
          className="w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
        >
          <option value="">None</option>
          {availableAgents.map((a: any) => (
            <option key={a.path} value={a.path}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      {/* Resume Session */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="resume-session"
          checked={resumeSession}
          onChange={(e) => handleResumeSessionChange(e.target.checked)}
          className="rounded border-[var(--vscode-input-border)]"
        />
        <label
          htmlFor="resume-session"
          className="text-xs text-[var(--vscode-foreground)]"
        >
          Resume Session
        </label>
      </div>

      {/* Session ID (enabled only when resume is true) */}
      <div>
        <label
          htmlFor="session-id"
          className="block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
        >
          Session ID
        </label>
        <input
          type="text"
          id="session-id"
          value={sessionId}
          onChange={(e) => handleSessionIdChange(e.target.value)}
          disabled={!resumeSession}
          placeholder="Auto-resume from previous"
          className="w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)] disabled:opacity-50"
        />
      </div>

      {/* Allow Dynamic Extension */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="allow-dynamic-extension"
          checked={allowDynamicExtension}
          onChange={(e) => handleAllowDynamicExtensionChange(e.target.checked)}
          className="rounded border-[var(--vscode-input-border)]"
        />
        <label
          htmlFor="allow-dynamic-extension"
          className="text-xs text-[var(--vscode-foreground)]"
        >
          Allow Dynamic Extension
        </label>
      </div>

      {/* End Condition Section */}
      <Collapsible
        title="End Condition"
        defaultOpen={hasEndCondition}
        onToggle={(isOpen) => {
          setHasEndCondition(isOpen);
          if (!isOpen) {
            sendUpdate({ endCondition: null });
          }
        }}
      >
        <div className="space-y-3 pt-2">
          {/* Script */}
          <div>
            <label
              htmlFor="end-condition-script"
              className="block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
            >
              Script
            </label>
            <input
              type="text"
              id="end-condition-script"
              value={endConditionScript}
              onChange={(e) => setEndConditionScript(e.target.value)}
              onBlur={handleEndConditionChange}
              placeholder="npm test"
              className="w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
            />
          </div>

          {/* Returns */}
          <div>
            <label
              htmlFor="end-condition-returns"
              className="block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
            >
              Expected Return
            </label>
            <input
              type="text"
              id="end-condition-returns"
              value={endConditionReturns}
              onChange={(e) => setEndConditionReturns(e.target.value)}
              onBlur={handleEndConditionChange}
              placeholder="true"
              className="w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
            />
          </div>

          {/* Timeout */}
          <div>
            <label
              htmlFor="end-condition-timeout"
              className="block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
            >
              Timeout (ms)
            </label>
            <input
              type="number"
              id="end-condition-timeout"
              value={endConditionTimeout}
              onChange={(e) =>
                setEndConditionTimeout(parseInt(e.target.value) || 30000)
              }
              onBlur={handleEndConditionChange}
              className="w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
            />
          </div>

          {/* Max Retries */}
          <div>
            <label
              htmlFor="end-condition-max-retries"
              className="block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
            >
              Max Retries
            </label>
            <input
              type="number"
              id="end-condition-max-retries"
              value={endConditionMaxRetries}
              onChange={(e) =>
                setEndConditionMaxRetries(parseInt(e.target.value) || 0)
              }
              onBlur={handleEndConditionChange}
              className="w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
            />
          </div>

          {/* Retry Prompt */}
          <div>
            <label
              htmlFor="end-condition-retry-prompt"
              className="block text-xs font-medium text-[var(--vscode-foreground)] mb-1"
            >
              Retry Prompt
            </label>
            <textarea
              id="end-condition-retry-prompt"
              value={endConditionRetryPrompt}
              onChange={(e) => setEndConditionRetryPrompt(e.target.value)}
              onBlur={handleEndConditionChange}
              placeholder="Validation failed: {error}&#10;&#10;Please fix the issues."
              rows={3}
              className="w-full px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
            />
          </div>
        </div>
      </Collapsible>
    </div>
  );
};
