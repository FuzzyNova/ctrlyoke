import React from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";

export const Header: React.FC = () => {
  const { workflowName, fileName, executionState } = useWorkflowStore();
  const { toggleSettingsDrawer } = useUiStore();

  const handleNew = () => {
    // TODO: Implement new workflow handler
    console.log("New workflow");
  };

  const handleLoad = () => {
    // TODO: Implement load workflow handler
    console.log("Load workflow");
  };

  const handleRun = () => {
    // TODO: Implement run handler
    console.log("Run workflow");
  };

  const getExecutionStateColor = () => {
    switch (executionState) {
      case "running":
        return "text-blue-500";
      case "paused":
        return "text-yellow-500";
      case "completed":
        return "text-green-500";
      case "error":
        return "text-red-500";
      default:
        return "text-[var(--vscode-foreground)]";
    }
  };

  const getExecutionStateText = () => {
    switch (executionState) {
      case "running":
        return "Running";
      case "paused":
        return "Paused";
      case "completed":
        return "Completed";
      case "error":
        return "Error";
      default:
        return "Ready";
    }
  };

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      {/* Left: Workflow controls */}
      <div className="flex items-center gap-2">
        <button
          className="px-3 py-1 text-sm rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] transition-colors"
          onClick={handleNew}
        >
          <i className="codicon codicon-add mr-1"></i>
          New
        </button>
        <button
          className="px-3 py-1 text-sm rounded bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] transition-colors"
          onClick={handleLoad}
        >
          <i className="codicon codicon-folder-opened mr-1"></i>
          Load
        </button>
      </div>

      {/* Center: Workflow status */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <i className="codicon codicon-file text-[var(--vscode-foreground)]"></i>
          <span className="text-sm text-[var(--vscode-foreground)]">
            {workflowName || fileName || "No workflow loaded"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <i
            className={`codicon codicon-circle-filled text-xs ${getExecutionStateColor()}`}
          ></i>
          <span className={`text-sm ${getExecutionStateColor()}`}>
            {getExecutionStateText()}
          </span>
        </div>
      </div>

      {/* Right: Execution controls + Settings */}
      <div className="flex items-center gap-2">
        <button
          className="px-4 py-1 text-sm rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleRun}
          disabled={executionState === "running" || !fileName}
        >
          <i className="codicon codicon-play mr-1"></i>
          Run
        </button>
        <button
          className="p-2 rounded hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
          onClick={toggleSettingsDrawer}
          title="Settings"
        >
          <i className="codicon codicon-settings-gear text-[var(--vscode-foreground)]"></i>
        </button>
      </div>
    </header>
  );
};
