import React from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";

export const PromptsPanel: React.FC = () => {
  const { prompts, currentStep } = useWorkflowStore();
  const { promptsCollapsed, togglePromptsCollapse } = useUiStore();

  const getPromptStatus = (index: number): string => {
    if (index < currentStep) return "completed";
    if (index === currentStep) return "active";
    return "pending";
  };

  const getStatusIcon = (status: string): string => {
    switch (status) {
      case "completed":
        return "codicon-check";
      case "active":
        return "codicon-sync";
      case "pending":
        return "codicon-circle-outline";
      default:
        return "codicon-circle-outline";
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case "completed":
        return "text-green-500";
      case "active":
        return "text-blue-500";
      case "pending":
        return "text-[var(--vscode-descriptionForeground)]";
      default:
        return "text-[var(--vscode-foreground)]";
    }
  };

  return (
    <div className="flex flex-col h-full border-r border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--vscode-panel-border)]">
        <div className="flex items-center gap-2">
          <i className="codicon codicon-list-unordered text-[var(--vscode-foreground)]"></i>
          <span className="text-sm font-medium text-[var(--vscode-foreground)]">
            Prompts
          </span>
          <span className="text-xs text-[var(--vscode-descriptionForeground)] bg-[var(--vscode-badge-background)] px-2 py-0.5 rounded">
            {prompts.length}
          </span>
        </div>
        <button
          className="p-1 rounded hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
          onClick={togglePromptsCollapse}
          title={promptsCollapsed ? "Expand" : "Collapse"}
        >
          <i
            className={`codicon ${
              promptsCollapsed
                ? "codicon-chevron-right"
                : "codicon-chevron-down"
            } text-[var(--vscode-foreground)]`}
          ></i>
        </button>
      </div>

      {/* Prompt list */}
      {!promptsCollapsed && (
        <div className="flex-1 overflow-y-auto">
          {prompts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full p-6 text-center">
              <i className="codicon codicon-inbox text-4xl text-[var(--vscode-descriptionForeground)] mb-3"></i>
              <p className="text-sm text-[var(--vscode-descriptionForeground)]">
                No prompts loaded
              </p>
              <p className="text-xs text-[var(--vscode-descriptionForeground)] mt-1">
                Load a workflow to get started
              </p>
            </div>
          ) : (
            <div className="py-2">
              {prompts.map((prompt, index) => {
                const status = getPromptStatus(index);
                const statusIcon = getStatusIcon(status);
                const statusColor = getStatusColor(status);

                return (
                  <div
                    key={index}
                    className={`px-3 py-2 cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)] transition-colors ${
                      status === "active"
                        ? "bg-[var(--vscode-list-activeSelectionBackground)]"
                        : ""
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <i
                        className={`codicon ${statusIcon} ${statusColor} mt-0.5 ${
                          status === "active" ? "animate-spin" : ""
                        }`}
                      ></i>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-medium text-[var(--vscode-descriptionForeground)]">
                            #{index + 1}
                          </span>
                          {prompt.id && (
                            <span className="text-xs text-[var(--vscode-foreground)] truncate">
                              {prompt.id}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-[var(--vscode-foreground)] line-clamp-2">
                          {typeof prompt.prompt === "string"
                            ? prompt.prompt
                            : "External file reference"}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
