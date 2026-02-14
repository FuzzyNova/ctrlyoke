import React from "react";
import { getExecutionStateBadgeClass } from "../../utils/status";
import { formatRelativeTimeVerbose } from "../../utils/time";

interface RecentWorkflow {
  workflowName: string;
  filePath: string;
  executionState: string;
  lastModifiedAt?: number;
  startedAt?: number;
}

interface RecentWorkflowsProps {
  workflows: RecentWorkflow[];
  currentFilePath: string | null;
  onSelect: (filePath: string) => void;
  onClearHistory: () => void;
  className?: string;
}

/**
 * RecentWorkflows - Dropdown list of recent workflows
 *
 * Features:
 * - Shows workflow name, state, and relative time
 * - Highlights current workflow
 * - Click to load workflow
 * - Clear history option
 */
export const RecentWorkflows: React.FC<RecentWorkflowsProps> = ({
  workflows,
  currentFilePath,
  onSelect,
  onClearHistory,
  className = "",
}) => {
  return (
    <div className={`recent-workflows flex flex-col h-full ${className}`}>
      {/* Header */}
      <div className="workflow-menu-header px-3 py-2 text-[11px] font-semibold text-[var(--vscode-descriptionForeground)] uppercase tracking-wider border-b border-[var(--vscode-dropdown-border)] bg-[var(--vscode-editor-background)] flex-shrink-0">
        Recent Workflows
      </div>

      {/* Scrollable Items */}
      <div className="workflow-menu-items overflow-y-auto overflow-x-hidden flex-1 min-h-0 py-1">
        {workflows.length === 0 ? (
          <div className="workflow-menu-empty px-3 py-6 text-center text-[var(--vscode-descriptionForeground)] text-sm">
            No recent workflows
          </div>
        ) : (
          workflows.map((workflow) => {
            const isCurrent = workflow.filePath === currentFilePath;
            const timeAgo = formatRelativeTimeVerbose(
              workflow.lastModifiedAt || workflow.startedAt
            );

            return (
              <button
                key={workflow.filePath}
                type="button"
                onClick={() => onSelect(workflow.filePath)}
                title={workflow.filePath}
                className={`workflow-menu-item w-full flex items-center justify-between px-3 py-2 text-left text-sm transition-colors border-none bg-transparent cursor-pointer gap-2 ${
                  isCurrent
                    ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)] font-semibold"
                    : "text-[var(--vscode-dropdown-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] hover:text-[var(--vscode-list-hoverForeground)]"
                }`}
              >
                {/* Workflow Name */}
                <span className="workflow-menu-item-name flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {workflow.workflowName}
                </span>

                {/* Execution State Badge */}
                <span
                  className={`workflow-menu-item-state text-[11px] px-1.5 py-[1px] rounded uppercase font-semibold flex-shrink-0 ${getExecutionStateBadgeClass(workflow.executionState)}`}
                >
                  {workflow.executionState}
                </span>

                {/* Time */}
                {timeAgo && (
                  <span className="workflow-menu-item-time text-[11px] text-[var(--vscode-descriptionForeground)] flex-shrink-0 ml-auto">
                    {timeAgo}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {/* Footer - Clear History */}
      {workflows.length > 0 && (
        <div className="workflow-menu-footer p-1 border-t border-[var(--vscode-dropdown-border)] bg-[var(--vscode-editor-background)] flex-shrink-0">
          <button
            type="button"
            onClick={onClearHistory}
            className="workflow-menu-action w-full px-3 py-1.5 border-none bg-transparent text-[var(--vscode-textLink-foreground)] text-center cursor-pointer text-xs rounded transition-colors hover:bg-[var(--vscode-list-hoverBackground)]"
          >
            Clear History
          </button>
        </div>
      )}
    </div>
  );
};
