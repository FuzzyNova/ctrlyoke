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
 * historical lineages carry favorite/remove. The shared header (search,
 * filters, close) applies to both regions below it.
 *
 * Layout: running rows render in a **pinned region** directly under the
 * header — content-sized up to `min(260px, 50%)`, scrolling internally past
 * that cap — while recent rows fill the rest in their own scroll container.
 * Pinning is the point: a running lineage stays reachable (and its controls
 * usable) no matter how far down the recent list the user has scrolled.
 * With nothing running, the region (and its caption) is absent entirely and
 * the list renders exactly as a single flat list.
 *
 * Features:
 * - Shows workflow name, state, and relative time (or a live elapsed timer
 *   while running)
 * - Highlights current workflow
 * - Click to load workflow or switch to a running instance
 * - Clear history option
 * - Virtualizes each region's rows once they grow large (see
 *   VirtualizedDropdownList) so a long history doesn't slow down opening
 *   the dropdown
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
  const runningScrollContainerRef = useRef<HTMLDivElement>(null);
  const recentScrollContainerRef = useRef<HTMLDivElement>(null);
  const runningRows = rows.filter(
    (row): row is Extract<UnifiedWorkflowRow, { kind: "running" }> =>
      row.kind === "running"
  );
  const recentRows = rows.filter(
    (row): row is Extract<UnifiedWorkflowRow, { kind: "recent" }> =>
      row.kind === "recent"
  );
  const hasRunningRows = runningRows.length > 0;
  const hasRecentRows = recentRows.length > 0;

  return (
    <div className={`recent-workflows flex flex-col h-full ${className}`}>
      {/* Header — owns search/filter/close for both regions below */}
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

      {/* Pinned running region — content-sized up to min(260px, 50%) so a
          handful of running rows cost only their own height while a large
          count scrolls internally instead of crowding out the recent list.
          The 50% term resolves because the dropdown is fixed-positioned with
          a definite height. When the recent region is empty the cap lifts
          (flex-1) so running rows can use the free space. */}
      {hasRunningRows && (
        <div
          className={`running-workflows-region flex flex-col border-b border-dropdown-border ${
            hasRecentRows
              ? "flex-shrink-0 max-h-[min(260px,50%)]"
              : "flex-1 min-h-0"
          }`}
        >
          <div className="flex flex-shrink-0 items-center gap-1.5 px-3 pt-1.5 pb-0.5 text-xxs font-semibold uppercase tracking-wider text-description-fg">
            <i
              className="codicon codicon-debug-line-by-line"
              aria-hidden="true"
            />
            <span>Running ({runningRows.length})</span>
          </div>
          <div
            ref={runningScrollContainerRef}
            className="running-workflow-items min-h-0 overflow-y-auto overflow-x-clip pb-1"
          >
            <VirtualizedDropdownList
              items={runningRows}
              getItemKey={(row) => row.key}
              scrollContainerRef={runningScrollContainerRef}
              renderItem={(row) => (
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
              )}
            />
          </div>
        </div>
      )}

      {/* Recent workflows — scrolls independently of the pinned running
          region, so running lineages stay reachable at any scroll depth */}
      <div
        ref={recentScrollContainerRef}
        className={`workflow-menu-items overflow-y-auto overflow-x-clip py-1 ${
          hasRecentRows || !hasRunningRows ? "flex-1 min-h-0" : "flex-shrink-0"
        }`}
      >
        {hasRecentRows ? (
          // Rows have no wrapping text (name/time truncate to one line), so
          // the default estimated height in VirtualizedDropdownList is fine.
          <VirtualizedDropdownList
            items={recentRows}
            getItemKey={(row) => row.key}
            scrollContainerRef={recentScrollContainerRef}
            renderItem={(row) => (
              <RecentWorkflowRow
                workflow={row.workflow}
                currentAddress={currentAddress}
                hasActiveTerminal={recentHasActiveTerminal}
                isNarrow={isNarrow}
                onSelect={onSelectRecent}
                onToggleFavorite={onToggleFavorite}
                onRemove={onRemove}
              />
            )}
          />
        ) : hasRunningRows ? // Running matches fill the pinned region above; an empty recent
        // region needs neither a "no match" message nor a New Workflow
        // prompt while workflows are actively running.
        null : isFiltering ? (
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
        )}
      </div>

      {/* Footer - Clear History: only ever targets persisted history, never
          live instances — hidden when no history rows exist */}
      {hasRecentRows && (
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
