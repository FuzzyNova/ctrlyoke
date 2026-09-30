import React, { useImperativeHandle, useRef } from "react";
import { formatRelativeTimeVerbose } from "../../utils/time";
import { WorkflowDropdownHeader } from "./WorkflowDropdownHeader";
import { RunningWorkflowItem } from "./RunningWorkflowItem";
import { HarnessIcon } from "../shared/HarnessIcon";
import { ExecutionStateBadge, VirtualizedDropdownList } from "../shared";
import {
  WorkflowRowLayout,
  RunIndicatorCell,
  RowActionRail,
  composeRowAccessibleName,
  isCompactRow,
} from "./WorkflowRowLayout";
import {
  WorkflowTokenUsage,
  hasWorkflowTokenUsage,
  workflowTokenTotalsAccessibleLabel,
} from "./WorkflowTokenUsage";
import {
  WORKFLOW_DROPDOWN_ROW_HEIGHT_ESTIMATE,
  WORKFLOW_ROW_KINDS,
  WORKFLOW_ROW_TIERS,
  type WorkflowRowTier,
} from "../../constants";
import { HARNESS_INFO } from "../../types/messages";
import type { WorkflowSummary } from "../../types/messages";
import type { RecentWorkflow } from "../../store/uiStore";
import type {
  WorkflowRunNavigationSummary,
  WorkflowViewAddress,
} from "@root/types/CtrlYokeTypes";
import type { ExecutionState } from "../../types/messages";
import { areWorkflowAddressesEqual } from "@utils/viewAddress";
import { isDrillableRunNav } from "@utils/runNavigation";
import { isWorkflowActive } from "../../utils/status";
import { getContextMenuOpener, useLongPress } from "@hooks/useLongPress";
import type { WorkflowContextMenuTarget } from "@hooks/useWorkflowContextMenu";
import { Icon } from "../shared/Icon";

/**
 * One row of the unified workflow dropdown list: either a lineage executing
 * here or a lineage known only from history. Running state lives on the row
 * itself — there is exactly one row per lineage, never a duplicate between a
 * "running" and a "recent" section.
 *
 * "Executing here" is decided by the caller and is not simply "the state is
 * active": a run enters on RUNNING/PAUSING and is retained across a following
 * PAUSED, but a lineage whose latest run was merely *found* paused on disk
 * renders as a `recent` row (see `uiStore.observedRunningWorkflowIds`).
 */
export type UnifiedWorkflowRow =
  | {
      kind: typeof WORKFLOW_ROW_KINDS.RUNNING;
      key: string;
      workflow: WorkflowSummary;
      /**
       * The lineage's recent-workflow entry, which the running row is hidden
       * behind while it executes. Carries the run-navigation summary and the
       * address a drill-in targets — `WorkflowSummary` itself has neither.
       */
      lineage?: RecentWorkflow;
    }
  | {
      kind: typeof WORKFLOW_ROW_KINDS.RECENT;
      key: string;
      workflow: RecentWorkflow;
    };

/** The run-navigation summary a row's drill affordance reads, whichever kind it is. */
function rowRunNav(
  row: UnifiedWorkflowRow
): WorkflowRunNavigationSummary | undefined {
  return row.kind === WORKFLOW_ROW_KINDS.RECENT
    ? row.workflow.runNav
    : row.lineage?.runNav;
}

/** Imperative handle for saving/restoring the recent-list scroll position across a drill-in/back round trip. */
export interface WorkflowListHandle {
  getScrollOffset: () => number;
  setScrollOffset: (offset: number) => void;
}

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
  onRemove?: (address: WorkflowViewAddress) => void;
  onToggleFavorite?: (address: WorkflowViewAddress) => void;
  /** Drills into a lineage's run panel without selecting/loading it. Omitted rows render no indicator. */
  onDrillIntoRuns?: (workflow: RecentWorkflow) => void;
  onOpenContextMenu?: (
    x: number,
    y: number,
    target: WorkflowContextMenuTarget,
    opener?: HTMLElement | null
  ) => void;
  onNewWorkflow?: () => void;
  onClose?: () => void;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  filtersOpen?: boolean;
  filtersActive?: boolean;
  onToggleFilters?: () => void;
  filterControls?: React.ReactNode;
  isFiltering?: boolean;
  tier?: WorkflowRowTier;
  className?: string;
}

interface RecentWorkflowRowProps {
  workflow: RecentWorkflow;
  currentAddress: WorkflowViewAddress | null;
  hasActiveTerminal?: (workflow: RecentWorkflow) => boolean;
  tier: WorkflowRowTier;
  onSelect: (address: WorkflowViewAddress) => void;
  onToggleFavorite?: (address: WorkflowViewAddress) => void;
  onRemove?: (address: WorkflowViewAddress) => void;
  onDrillIntoRuns?: (workflow: RecentWorkflow) => void;
  onOpenContextMenu?: (
    x: number,
    y: number,
    target: WorkflowContextMenuTarget,
    opener?: HTMLElement | null
  ) => void;
  /** List-scoped: reserve the indicator's track even on this row when a sibling row is drillable, so time/badge columns stay aligned. */
  showRunIndicatorTrack: boolean;
}

const RecentWorkflowRow: React.FC<RecentWorkflowRowProps> = ({
  workflow,
  currentAddress,
  hasActiveTerminal,
  tier,
  onSelect,
  onToggleFavorite,
  onRemove,
  onDrillIntoRuns,
  onOpenContextMenu,
  showRunIndicatorTrack,
}) => {
  const isCurrent = areWorkflowAddressesEqual(workflow.address, currentAddress);
  const showTerminalIcon = hasActiveTerminal?.(workflow) ?? false;
  const showStepCount =
    typeof workflow.totalSteps === "number" && workflow.totalSteps > 0;
  const timeAgo = formatRelativeTimeVerbose(
    workflow.lastModifiedAt || workflow.startedAt
  );
  const accessibleName = composeRowAccessibleName([
    workflow.workflowName,
    workflow.executionState,
    showStepCount &&
      `${workflow.totalSteps} step${workflow.totalSteps === 1 ? "" : "s"}`,
    workflowTokenTotalsAccessibleLabel(workflow.tokenTotals),
    timeAgo,
    showTerminalIcon && "terminal session is still running",
  ]);
  const openContextMenu = (
    x: number,
    y: number,
    opener: HTMLElement | null = null
  ) => {
    onOpenContextMenu?.(
      x,
      y,
      {
        address: workflow.address,
        workflowName: workflow.workflowName,
        scope: "lineage",
        isFavorite: workflow.isFavorite,
        runDirectory: workflow.runDirectory,
        isExecuting: isWorkflowActive(
          workflow.executionState as ExecutionState
        ),
        isUnstarted: workflow.unstarted,
      },
      opener
    );
  };
  const longPressHandlers = useLongPress(
    onOpenContextMenu ? openContextMenu : undefined
  );

  return (
    /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the non-focusable row container owns right-click/long-press gestures; native child controls remain focusable */
    <div
      {...longPressHandlers}
      onContextMenu={(event) => {
        event.preventDefault();
        openContextMenu(
          event.clientX,
          event.clientY,
          getContextMenuOpener(event.currentTarget, event.target)
        );
      }}
      role="listitem"
      aria-label={accessibleName}
      title={workflow.address.workflowKey}
      className={`workflow-menu-item group flex items-center px-2 py-2 text-left text-sm transition-colors gap-2 ${
        isCurrent
          ? "bg-list-active-bg text-list-active-fg font-semibold cy-dropdown-row-selected"
          : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg cy-dropdown-row"
      }`}
    >
      <WorkflowRowLayout
        tier={tier}
        onClick={() => onSelect(workflow.address)}
        ariaLabel={accessibleName}
        harness={
          workflow.harness && (
            <HarnessIcon harnessId={workflow.harness} size={14} />
          )
        }
        harnessTitle={
          workflow.harness
            ? (HARNESS_INFO[workflow.harness]?.name ?? workflow.harness)
            : undefined
        }
        label={
          <span className="workflow-menu-item-name">
            {workflow.workflowName}
          </span>
        }
        count={
          showStepCount
            ? `${workflow.totalSteps} step${workflow.totalSteps === 1 ? "" : "s"}`
            : undefined
        }
        worktree={workflow.worktree}
        glyph={
          showTerminalIcon && (
            <Icon
              name="terminal"
              title="Terminal session is still running"
              aria-label="Terminal session is still running"
            />
          )
        }
        badge={
          <ExecutionStateBadge
            state={workflow.executionState}
            isNarrow={isCompactRow(tier)}
            unstarted={workflow.unstarted}
            className="workflow-menu-item-state"
          />
        }
        usage={
          hasWorkflowTokenUsage(workflow.tokenTotals) ? (
            <WorkflowTokenUsage totals={workflow.tokenTotals} />
          ) : undefined
        }
        time={
          timeAgo ? (
            <span className="workflow-menu-item-time">{timeAgo}</span>
          ) : undefined
        }
      />

      {/* Run indicator — sibling of the primary button, not part of its grid.
          Drills into the run panel without selecting/loading the lineage. */}
      {showRunIndicatorTrack && (
        <RunIndicatorCell
          runNav={workflow.runNav}
          workflowName={workflow.workflowName}
          onDrill={
            onDrillIntoRuns ? () => onDrillIntoRuns(workflow) : undefined
          }
        />
      )}

      <RowActionRail>
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
            className={`flex h-8 w-6 flex-shrink-0 items-center justify-center rounded px-0 py-0 leading-none transition-colors ${
              workflow.isFavorite
                ? "text-favorite hover:opacity-80 hover:bg-toolbar-hover-bg"
                : "opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-favorite hover:opacity-80 hover:bg-toolbar-hover-bg"
            }`}
          >
            <Icon
              name={
                workflow.isFavorite ? "codicon-star-full" : "codicon-star-empty"
              }
              className="block leading-none"
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
            className="flex h-8 w-6 flex-shrink-0 items-center justify-center rounded px-0 py-0 leading-none text-description-fg opacity-0 transition-colors group-hover:opacity-100 hover:bg-toolbar-hover-bg hover:text-error-fg focus:opacity-100"
          >
            <Icon name="trash" className="block leading-none" />
          </button>
        )}
      </RowActionRail>
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
 * the list renders exactly as a single flat list. That scarcity is why
 * membership is earned by executing rather than by state alone — paused runs
 * accumulate without bound and would crowd live work out of the cap.
 *
 * Features:
 * - Shows workflow name, state, and relative time (or a live elapsed timer
 *   while running)
 * - Highlights current workflow
 * - Click to load workflow or switch to a running instance
 * - Virtualizes each region's rows once they grow large (see
 *   VirtualizedDropdownList) so a long history doesn't slow down opening
 *   the dropdown
 */
export const WorkflowList = React.forwardRef<
  WorkflowListHandle,
  WorkflowListProps
>(function WorkflowList(
  {
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
    onRemove,
    onToggleFavorite,
    onDrillIntoRuns,
    onOpenContextMenu,
    onNewWorkflow,
    onClose,
    searchValue = "",
    onSearchChange,
    filtersOpen = false,
    filtersActive = false,
    onToggleFilters,
    filterControls,
    isFiltering = false,
    tier = WORKFLOW_ROW_TIERS.STACKED,
    className = "",
  },
  ref
) {
  const runningScrollContainerRef = useRef<HTMLDivElement>(null);
  const recentScrollContainerRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      getScrollOffset: () => recentScrollContainerRef.current?.scrollTop ?? 0,
      setScrollOffset: (offset) => {
        if (recentScrollContainerRef.current) {
          recentScrollContainerRef.current.scrollTop = offset;
        }
      },
    }),
    []
  );
  const runningRows = rows.filter(
    (
      row
    ): row is Extract<
      UnifiedWorkflowRow,
      { kind: typeof WORKFLOW_ROW_KINDS.RUNNING }
    > => row.kind === WORKFLOW_ROW_KINDS.RUNNING
  );
  const recentRows = rows.filter(
    (
      row
    ): row is Extract<
      UnifiedWorkflowRow,
      { kind: typeof WORKFLOW_ROW_KINDS.RECENT }
    > => row.kind === WORKFLOW_ROW_KINDS.RECENT
  );
  const hasRunningRows = runningRows.length > 0;
  const hasRecentRows = recentRows.length > 0;
  // List-scoped, not row-scoped, and spanning *both* regions: reserve the
  // indicator track on every row as soon as one row anywhere is drillable, so
  // the state/time columns stay aligned between a pinned running row and the
  // recent rows directly beneath it. A list with no drillable rows renders
  // without the track at all.
  const hasDrillableRow = rows.some((row) => isDrillableRunNav(rowRunNav(row)));
  const estimatedRowHeight = WORKFLOW_DROPDOWN_ROW_HEIGHT_ESTIMATE;

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
          role="region"
          aria-label="Running workflows"
          className={`running-workflows-region flex flex-col border-b border-dropdown-border ${
            hasRecentRows
              ? "flex-shrink-0 max-h-[min(260px,50%)]"
              : "flex-1 min-h-0"
          }`}
        >
          <div className="flex flex-shrink-0 items-center gap-1.5 px-3 pt-1.5 pb-0.5 text-xxs font-semibold uppercase tracking-wider text-description-fg">
            <Icon name="debug-line-by-line" />
            <span>Running ({runningRows.length})</span>
          </div>
          <div
            ref={runningScrollContainerRef}
            role="list"
            aria-label="Running workflows"
            className="running-workflow-items min-h-0 overflow-y-auto overflow-x-clip pb-1"
          >
            <VirtualizedDropdownList
              items={runningRows}
              getItemKey={(row) => row.key}
              scrollContainerRef={runningScrollContainerRef}
              estimatedRowHeight={estimatedRowHeight}
              renderItem={(row) => (
                <RunningWorkflowItem
                  workflow={row.workflow}
                  isCurrent={row.workflow.id === activeWorkflowId}
                  hasActiveTerminal={runningHasActiveTerminal(row.workflow.id)}
                  tier={tier}
                  runNav={row.lineage?.runNav}
                  lineage={row.lineage}
                  showRunIndicatorTrack={hasDrillableRow}
                  onDrillIntoRuns={
                    row.lineage && onDrillIntoRuns
                      ? () => onDrillIntoRuns(row.lineage!)
                      : undefined
                  }
                  onOpenContextMenu={onOpenContextMenu}
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
        role="list"
        aria-label="Recent workflows"
        className={`workflow-menu-items overflow-y-auto overflow-x-clip py-1 ${
          hasRecentRows || !hasRunningRows ? "flex-1 min-h-0" : "flex-shrink-0"
        }`}
      >
        {hasRecentRows ? (
          // Rows never wrap (every line truncates), so a flat per-layout
          // estimate is enough — but it has to follow the layout, since
          // stacked rows are half again as tall.
          <VirtualizedDropdownList
            items={recentRows}
            getItemKey={(row) => row.key}
            scrollContainerRef={recentScrollContainerRef}
            estimatedRowHeight={estimatedRowHeight}
            renderItem={(row) => (
              <RecentWorkflowRow
                workflow={row.workflow}
                currentAddress={currentAddress}
                hasActiveTerminal={recentHasActiveTerminal}
                tier={tier}
                onSelect={onSelectRecent}
                onToggleFavorite={onToggleFavorite}
                onRemove={onRemove}
                onDrillIntoRuns={onDrillIntoRuns}
                onOpenContextMenu={onOpenContextMenu}
                showRunIndicatorTrack={hasDrillableRow}
              />
            )}
          />
        ) : hasRunningRows ? null : isFiltering ? ( // prompt while workflows are actively running. // region needs neither a "no match" message nor a New Workflow // Running matches fill the pinned region above; an empty recent
          <div className="w-full px-3 py-2 text-left text-sm text-description-fg">
            No workflows match your search.
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onNewWorkflow?.()}
            className="cy-dropdown-row w-full px-3 py-2 text-left text-sm text-description-fg hover:bg-list-hover-bg hover:text-list-highlight-fg flex items-center gap-2"
          >
            <Icon name="add" className="text-xs" />
            New Workflow
          </button>
        )}
      </div>
    </div>
  );
});
