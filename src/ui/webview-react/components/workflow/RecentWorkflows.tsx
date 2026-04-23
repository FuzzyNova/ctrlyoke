import React from "react";
import {
  getExecutionStateBadgeClass,
  getExecutionStateBadgeIcon,
} from "../../utils/status";
import { formatRelativeTimeVerbose } from "../../utils/time";
import { WorkflowDropdownHeader } from "./WorkflowDropdownHeader";

interface RecentWorkflow {
  workflowName: string;
  filePath: string;
  executionState: string;
  lastModifiedAt?: number;
  startedAt?: number;
  isFavorite?: boolean;
}

interface RecentWorkflowsProps {
  workflows: RecentWorkflow[];
  currentFilePath: string | null;
  hasActiveTerminal?: (workflow: RecentWorkflow) => boolean;
  onSelect: (filePath: string) => void;
  onClearHistory: () => void;
  onRemove?: (filePath: string) => void;
  onToggleFavorite?: (filePath: string) => void;
  onNewWorkflow?: () => void;
  onClose?: () => void;
  showCloseButton?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  showSearch?: boolean;
  isFiltering?: boolean;
  isNarrow?: boolean;
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
  hasActiveTerminal,
  onSelect,
  onClearHistory,
  onRemove,
  onToggleFavorite,
  onNewWorkflow,
  onClose,
  showCloseButton = false,
  searchValue = "",
  onSearchChange,
  showSearch = false,
  isFiltering = false,
  isNarrow = false,
  className = "",
}) => {
  return (
    <div className={`recent-workflows flex flex-col h-full ${className}`}>
      {/* Header */}
      <WorkflowDropdownHeader
        icon="codicon-checklist"
        title="Workflows"
        onClose={showCloseButton ? onClose : undefined}
        searchValue={searchValue}
        onSearchChange={onSearchChange}
        showSearch={showSearch}
      />

      {/* Scrollable Items */}
      <div className="workflow-menu-items overflow-y-auto overflow-x-hidden flex-1 min-h-0 py-1">
        {workflows.length === 0 ? (
          isFiltering ? (
            <div className="w-full px-3 py-2 text-left text-sm text-description-fg">
              No recent workflows match your search.
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onNewWorkflow?.()}
              className="w-full px-3 py-2 text-left text-sm text-description-fg hover:bg-list-hover-bg hover:text-list-highlight-fg flex items-center gap-2"
            >
              <i className="codicon codicon-add text-[11px]" />
              New Workflow
            </button>
          )
        ) : (
          workflows.map((workflow) => {
            const isCurrent = workflow.filePath === currentFilePath;
            const showTerminalIcon = hasActiveTerminal?.(workflow) ?? false;
            const timeAgo = formatRelativeTimeVerbose(
              workflow.lastModifiedAt || workflow.startedAt
            );

            return (
              <div
                key={workflow.filePath}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(workflow.filePath)}
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

                {showTerminalIcon && (
                  <span
                    className="flex-shrink-0 w-4 flex items-center justify-center text-description-fg"
                    title="Terminal session is still running"
                    aria-label="Terminal session is still running"
                  >
                    <i className="codicon codicon-terminal" />
                  </span>
                )}

                {/* Execution State Badge — fixed-width column so badges align across rows */}
                <span
                  className={`flex-shrink-0 flex justify-center ${isNarrow ? "w-[28px]" : "w-[76px]"}`}
                >
                  <span
                    className={`workflow-menu-item-state inline-flex items-center text-[11px] px-1.5 py-[1px] rounded uppercase font-semibold ${getExecutionStateBadgeClass(workflow.executionState)}`}
                    title={isNarrow ? workflow.executionState : undefined}
                  >
                    {isNarrow ? (
                      <i
                        className={`codicon ${getExecutionStateBadgeIcon(workflow.executionState)}`}
                      />
                    ) : (
                      workflow.executionState
                    )}
                  </span>
                </span>

                {/* Time — fixed-width column so timestamps align across rows */}
                <span className="workflow-menu-item-time text-[11px] text-description-fg flex-shrink-0 w-[80px] text-right">
                  {timeAgo || ""}
                </span>

                {onToggleFavorite && (
                  <button
                    type="button"
                    title={
                      workflow.isFavorite
                        ? "Remove from favorites"
                        : "Add to favorites"
                    }
                    aria-label={
                      workflow.isFavorite
                        ? "Remove from favorites"
                        : "Add to favorites"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(workflow.filePath);
                    }}
                    className={`flex-shrink-0 p-0.5 rounded transition-colors ${
                      workflow.isFavorite
                        ? "text-yellow-400 hover:text-yellow-300 hover:bg-toolbar-hover-bg"
                        : "opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-yellow-400 hover:bg-toolbar-hover-bg"
                    }`}
                  >
                    <i
                      className={`codicon ${workflow.isFavorite ? "codicon-star-full" : "codicon-star-empty"}`}
                    />
                  </button>
                )}

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
            className="workflow-menu-action w-full px-3 py-1.5 border-none bg-transparent text-link-fg text-center cursor-pointer text-xs rounded transition-colors hover:bg-list-hover-bg"
          >
            Clear History
          </button>
        </div>
      )}
    </div>
  );
};
