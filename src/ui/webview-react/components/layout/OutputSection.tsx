import React, { useEffect, useRef } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";

export const OutputSection: React.FC = () => {
  const { currentStep, cliOutputs } = useWorkflowStore();
  const {
    outputCollapsed,
    toggleOutputCollapse,
    autoscrollEnabled,
    setAutoscroll,
  } = useUiStore();
  const outputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll effect
  useEffect(() => {
    if (autoscrollEnabled && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [cliOutputs, currentStep, autoscrollEnabled]);

  const handleExport = () => {
    // TODO: Implement export handler
    console.log("Export output");
  };

  const currentOutputs = cliOutputs[currentStep] || [];

  return (
    <div className="flex flex-col h-full border-r border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--vscode-panel-border)]">
        <div className="flex items-center gap-2">
          <i className="codicon codicon-terminal text-[var(--vscode-foreground)]"></i>
          <span className="text-sm font-medium text-[var(--vscode-foreground)]">
            Output
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Autoscroll toggle */}
          <button
            className={`p-1 rounded transition-colors ${
              autoscrollEnabled
                ? "bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)]"
                : "hover:bg-[var(--vscode-list-hoverBackground)] text-[var(--vscode-foreground)]"
            }`}
            onClick={() => setAutoscroll(!autoscrollEnabled)}
            title={
              autoscrollEnabled ? "Disable autoscroll" : "Enable autoscroll"
            }
          >
            <i className="codicon codicon-arrow-down"></i>
          </button>

          {/* Export button */}
          <button
            className="p-1 rounded hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
            onClick={handleExport}
            title="Export output"
            disabled={currentOutputs.length === 0}
          >
            <i className="codicon codicon-export text-[var(--vscode-foreground)]"></i>
          </button>

          {/* Collapse button */}
          <button
            className="p-1 rounded hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
            onClick={toggleOutputCollapse}
            title={outputCollapsed ? "Expand" : "Collapse"}
          >
            <i
              className={`codicon ${
                outputCollapsed
                  ? "codicon-chevron-right"
                  : "codicon-chevron-down"
              } text-[var(--vscode-foreground)]`}
            ></i>
          </button>
        </div>
      </div>

      {/* Output area */}
      {!outputCollapsed && (
        <div
          ref={outputRef}
          className="flex-1 overflow-y-auto p-3 font-mono text-sm"
        >
          {currentOutputs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <i className="codicon codicon-output text-4xl text-[var(--vscode-descriptionForeground)] mb-3"></i>
              <p className="text-sm text-[var(--vscode-descriptionForeground)]">
                No output yet
              </p>
              <p className="text-xs text-[var(--vscode-descriptionForeground)] mt-1">
                Run a workflow to see output here
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {currentOutputs.map((output, index) => (
                <div
                  key={index}
                  className="text-[var(--vscode-terminal-foreground)] whitespace-pre-wrap break-words"
                >
                  {output}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
