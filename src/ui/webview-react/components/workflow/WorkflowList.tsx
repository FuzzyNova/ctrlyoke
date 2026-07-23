import React, { useRef } from "react";
import {
  getExecutionStateBadgeClass,
  getExecutionStateBadgeIcon,
} from "../../utils/status";
import { formatRelativeTimeVerbose } from "../../utils/time";
import { WorkflowDropdownHeader } from "./WorkflowDropdownHeader";
import { RunningWorkflowItem } from "./RunningWorkflowItem";
import { HarnessIcon } from "../shared/HarnessIcon";
import { VirtualizedDropdownList } from "../shared";
import { HARNESS_INFO } from "../../types/messages";
import type { WorkflowSummary } from "../../types/messages";
import type { RecentWorkflow } from "../../store/uiStore";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import { areWorkflowAddressesEqual } from "@utils/viewAddress";

/**
 * One row of the unified workflow dropdown list: either a lineage with an
 * active instance (running/pausing/paused) or a lineage known only from
 * history. Running state lives on the row itself — there is exactly one row
 * per lineage, never a duplicate between a "running" and a "recent" section.
 */
export type UnifiedWorkflowRow =
  | { kind: "running"; key: string; workflow: WorkflowSummary }
  | { kind: "recent"; key: string; workflow: RecentWorkflow };

interface WorkflowListProps {
  rows: UnifiedWorkflowRow[];
  currentAddress: WorkflowViewAddress | null;
  activeWorkflowId: string | null;
  runningHasActiveTerminal: (workflowId: string) => boolean;
  recentHasActiveTerminal?: (workflow: RecentWorkflow) => boolean;
  onSelectRecent: (address: WorkflowViewAddress) => void;
  onSwitchRunning: (workflowId: string) => void;
  onPauseRunning: (workflow: WorkflowSummary) => void;
  onCancelPauseRunning: (workflow: WorkflowSummary) => void;
  onResumeRunning: (workflow: WorkflowSummary) => void;
  onStopRunning: (workflow: WorkflowSummary) => void;
  onClearHistory: () => void;
  onRemove?: (address: WorkflowViewAddress) => void;
  onToggleFavorite?: (address: WorkflowViewAddress) => void;
  onNewWorkflow?: () => void;
  onClose?: () => void;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  filtersOpen?: boolean;
  filtersActive?: boolean;
  onToggleFilters?: () => void;
  filterControls?: React.ReactNode;
  isFiltering?: boolean;
  isNarrow?: boolean;
  className?: string;
}

interface RecentWorkflowRowProps {
  workflow: RecentWorkflow;
  currentAddress: WorkflowViewAddress | null;
  hasActiveTerminal?: (workflow: RecentWorkflow) => boolean;
  isNarrow: boolean;
  onSelect: (address: WorkflowViewAddress) => void;
  onToggleFavorite?: (address: WorkflowViewAddress) => void;
  onRemove?: (address: WorkflowViewAddress) => void;
}

const RecentWorkflowRow: React.FC<RecentWorkflowRowProps> = ({
  workflow,
  currentAddress,
  hasActiveTerminal,
  isNarrow,
  onSelect,
  onToggleFavorite,
  onRemove,
}) => {
  const isCurrent = areWorkflowAddressesEqual(workflow.address, currentAddress);
  const showTerminalIcon = hasActiveTerminal?.(workflow) ?? false;
  const showStepCount =
    typeof workflow.totalSteps === "number" && workflow.totalSteps > 0;
  const timeAgo = formatRelativeTimeVerbose(
    workflow.lastModifiedAt || workflow.startedAt
  );

  return (
    <div
      title={workflow.address.workflowKey}
      className={`workflow-menu-item group flex items-center px-2 py-2 text-left text-sm transition-colors gap-2 ${
        isCurrent
          ? "bg-list-active-bg text-list-active-fg font-semibold fp-dropdown-row-selected"
          : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg fp-dropdown-row"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(workflow.address)}
        className={`workflow-row-primary workflow-row-primary-recent min-w-0 flex-1 appearance-none overflow-hidden border-none bg-transparent p-0 text-left text-inherit cursor-pointer ${isNarrow ? "workflow-row-primary-narrow" : ""}`}
      >
        {/* Harness icon */}
        <span
          className="col-start-1 flex w-[14px] items-center justify-center"
          title={
            workflow.harness
              ? (HARNESS_INFO[workflow.harness]?.name ?? workflow.harness)
              : undefined
          }
        >
          {workflow.harness && (
            <HarnessIcon harnessId={workflow.harness} size={14} />
          )}
        </span>

        {/* Workflow Name */}
        <span className="workflow-menu-item-name col-start-2 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {workflow.workflowName}
        </span>

        {/* Step count */}
        <span
          className="col-start-3 text-xs text-description-fg font-mono"
          title={
            showStepCount
              ? `${workflow.totalSteps} step${workflow.totalSteps === 1 ? "" : "s"}`
              : undefined
          }
        >
          {showStepCount
            ? isNarrow
              ? `${workflow.totalSteps}`
              : `${workflow.totalSteps} step${workflow.totalSteps === 1 ? "" : "s"}`
            : ""}
        </span>

        <span
          className="col-start-4 w-4 flex items-center justify-center text-description-fg"
          title={
            showTerminalIcon ? "Terminal session is still running" : undefined
          }
          aria-label={
            showTerminalIcon ? "Terminal session is still running" : undefined
          }
        >
          {showTerminalIcon && <i className="codicon codicon-terminal" />}
        </span>

        {/* Execution State Badge — fixed-width column so badges align across rows */}
        <span className="col-start-5 flex justify-center">
          <span
            className={`workflow-menu-item-state inline-flex items-center text-xs px-1.5 py-px rounded uppercase font-semibold ${getExecutionStateBadgeClass(workflow.executionState)}`}
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
        <span className="workflow-menu-item-time col-start-6 text-xs text-description-fg w-[80px] text-right">
          {timeAgo || ""}
        </span>
      </button>

      {onToggleFavorite && (
        <button
          type="button"
          title={
            workflow.isFavorite ? "Remove from favorites" : "Add to favorites"
          }
          aria-label={
            workflow.isFavorite ? "Remove from favorites" : "Add to favorites"
          }
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(workflow.address);
          }}
          className={`flex-shrink-0 p-0.5 rounded transition-colors ${
            workflow.isFavorite
              ? "text-favorite hover:opacity-80 hover:bg-toolbar-hover-bg"
              : "opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-favorite hover:opacity-80 hover:bg-toolbar-hover-bg"
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
            onRemove(workflow.address);
          }}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 flex-shrink-0 p-0.5 rounded text-description-fg hover:text-error-fg hover:bg-toolbar-hover-bg transition-colors"
        >
          <i className="codicon codicon-trash" />
        </button>
      )}
    </div>
  );
};

/**
 * WorkflowList - Unified dropdown list of workflow lineages
 *
 * One row per lineage regardless of whether it currently has a running
 * instance: running lineages carry their inline pause/resume/stop controls,
 * historical lineages carry favorite/remove, and both live in the same
 * virtualized list under one header — running rows sort first because
 * `rows` already arrives in that order.
 *
 * Features:
 * - Shows workflow name, state, and relative time (or a live elapsed timer
 *   while running)
 * - Highlights current workflow
 * - Click to load workflow or switch to a running instance
 * - Clear history option
 * - Virtualizes rows once the list grows large (see VirtualizedDropdownList)
 *   so a long history doesn't slow down opening the dropdown
 */
export const WorkflowList: React.FC<WorkflowListProps> = ({
  rows,
  currentAddress,
  activeWorkflowId,
  runningHasActiveTerminal,
  recentHasActiveTerminal,
  onSelectRecent,
  onSwitchRunning,
  onPauseRunning,
  onCancelPauseRunning,
  onResumeRunning,
  onStopRunning,
  onClearHistory,
  onRemove,
  onToggleFavorite,
  onNewWorkflow,
  onClose,
  searchValue = "",
  onSearchChange,
  filtersOpen = false,
  filtersActive = false,
  onToggleFilters,
  filterControls,
  isFiltering = false,
  isNarrow = false,
  className = "",
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Clear History only ever targets persisted history, never live instances —
  // hide the footer when the list is showing running lineages with no history yet.
  const hasHistoryRows = rows.some((row) => row.kind === "recent");

  return (
    <div className={`recent-workflows flex flex-col h-full ${className}`}>
      {/* Header */}
      <WorkflowDropdownHeader
        icon="codicon-checklist"
        title="Workflows"
        onClose={onClose}
        searchValue={searchValue}
        onSearchChange={onSearchChange}
        showSearch
        showFilters
        filtersOpen={filtersOpen}
        filtersActive={filtersActive}
        onToggleFilters={onToggleFilters}
        filterControls={filterControls}
      />

      {/* Scrollable Items */}
      <div
        ref={scrollContainerRef}
        className="workflow-menu-items overflow-y-auto overflow-x-clip flex-1 min-h-0 py-1"
      >
        {rows.length === 0 ? (
          isFiltering ? (
            <div className="w-full px-3 py-2 text-left text-sm text-description-fg">
              No workflows match your search.
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onNewWorkflow?.()}
              className="fp-dropdown-row w-full px-3 py-2 text-left text-sm text-description-fg hover:bg-list-hover-bg hover:text-list-highlight-fg flex items-center gap-2"
            >
              <i className="codicon codicon-add text-xs" />
              New Workflow
            </button>
          )
        ) : (
          // Rows have no wrapping text (name/time truncate to one line), so
          // the default estimated height in VirtualizedDropdownList is fine.
          <VirtualizedDropdownList
            items={rows}
            getItemKey={(row) => row.key}
            scrollContainerRef={scrollContainerRef}
            renderItem={(row) =>
              row.kind === "running" ? (
                <RunningWorkflowItem
                  workflow={row.workflow}
                  isCurrent={row.workflow.id === activeWorkflowId}
                  hasActiveTerminal={runningHasActiveTerminal(row.workflow.id)}
                  isNarrow={isNarrow}
                  onClick={() => onSwitchRunning(row.workflow.id)}
                  onPause={() => onPauseRunning(row.workflow)}
                  onCancelPause={() => onCancelPauseRunning(row.workflow)}
                  onResume={() => onResumeRunning(row.workflow)}
                  onStop={() => onStopRunning(row.workflow)}
                />
              ) : (
                <RecentWorkflowRow
                  workflow={row.workflow}
                  currentAddress={currentAddress}
                  hasActiveTerminal={recentHasActiveTerminal}
                  isNarrow={isNarrow}
                  onSelect={onSelectRecent}
                  onToggleFavorite={onToggleFavorite}
                  onRemove={onRemove}
                />
              )
            }
          />
        )}
      </div>

      {/* Footer - Clear History */}
      {hasHistoryRows && (
        <div className="workflow-menu-footer p-1 border-t border-dropdown-border bg-editor-bg flex-shrink-0">
          <button
            type="button"
            onClick={onClearHistory}
            className="workflow-menu-action fp-dropdown-row w-full px-3 py-1.5 border-none bg-transparent text-link-fg text-center cursor-pointer text-xs rounded transition-colors hover:bg-list-hover-bg"
          >
            Clear History
          </button>
        </div>
      )}
    </div>
  );
};
