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
  onRemove?: (filePath: string) => void;
  onNewWorkflow?: () => void;
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
  onRemove,
  onNewWorkflow,
  className = "",
}) => {
  return (
    <div className={`recent-workflows flex flex-col h-full ${className}`}>
      {/* Header */}
      <div className="workflow-menu-header px-3 py-2 text-[11px] font-semibold text-description-fg uppercase tracking-wider border-b border-dropdown-border bg-editor-bg flex-shrink-0">
        Workflows
      </div>

      {/* Scrollable Items */}
      <div className="workflow-menu-items overflow-y-auto overflow-x-hidden flex-1 min-h-0 py-1">
        {workflows.length === 0 ? (
          <button
            type="button"
            onClick={() => onNewWorkflow?.()}
            onTouchEnd={(e) => { e.preventDefault(); onNewWorkflow?.(); }}
            className="w-full px-3 py-2 text-left text-sm text-description-fg hover:bg-list-hover-bg hover:text-list-highlight-fg flex items-center gap-2"
          >
            <i className="codicon codicon-add text-[11px]" />
            New Workflow
          </button>
        ) : (
          workflows.map((workflow) => {
            const isCurrent = workflow.filePath === currentFilePath;
            const timeAgo = formatRelativeTimeVerbose(
              workflow.lastModifiedAt || workflow.startedAt
            );

            return (
              <div
                key={workflow.filePath}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(workflow.filePath)}
                onTouchEnd={(e) => { e.preventDefault(); onSelect(workflow.filePath); }}
                onKeyDown={(e) =>
                  e.key === "Enter" && onSelect(workflow.filePath)
                }
                title={workflow.filePath}
                className={`workflow-menu-item group w-full flex items-center justify-between px-3 py-2 text-left text-sm transition-colors cursor-pointer gap-2 ${
                  isCurrent
                    ? "bg-list-active-bg text-list-active-fg font-semibold"
                    : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg"
                }`}
              >
                {/* Workflow Name */}
                <span className="workflow-menu-item-name flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {workflow.workflowName}
                </span>

                {/* Execution State Badge — fixed-width column so badges align across rows */}
                <span className="flex-shrink-0 w-[76px] flex justify-center">
                  <span
                    className={`workflow-menu-item-state text-[11px] px-1.5 py-[1px] rounded uppercase font-semibold ${getExecutionStateBadgeClass(workflow.executionState)}`}
                  >
                    {workflow.executionState}
                  </span>
                </span>

                {/* Time — fixed-width column so timestamps align across rows */}
                <span className="workflow-menu-item-time text-[11px] text-description-fg flex-shrink-0 w-[80px] text-right">
                  {timeAgo || ""}
                </span>

                {/* Delete button — visible only on row hover */}
                {onRemove && (
                  <button
                    type="button"
                    title="Remove from history"
                    aria-label="Remove from history"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(workflow.filePath);
                    }}
                    onTouchEnd={(e) => { e.preventDefault(); onRemove(workflow.filePath); }}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 flex-shrink-0 p-0.5 rounded text-description-fg hover:text-error-fg hover:bg-toolbar-hover-bg transition-colors"
                  >
                    <i className="codicon codicon-trash" />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer - Clear History */}
      {workflows.length > 0 && (
        <div className="workflow-menu-footer p-1 border-t border-dropdown-border bg-editor-bg flex-shrink-0">
          <button
            type="button"
            onClick={onClearHistory}
            onTouchEnd={(e) => { e.preventDefault(); onClearHistory(); }}
            className="workflow-menu-action w-full px-3 py-1.5 border-none bg-transparent text-link-fg text-center cursor-pointer text-xs rounded transition-colors hover:bg-list-hover-bg"
          >
            Clear History
          </button>
        </div>
      )}
    </div>
  );
};
