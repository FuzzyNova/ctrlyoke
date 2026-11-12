import React, { useImperativeHandle, useRef } from "react";
import { formatRelativeTimeVerbose } from "../../utils/time";
import { WorkflowDropdownHeader } from "./WorkflowDropdownHeader";
import { RunningWorkflowItem } from "./RunningWorkflowItem";
import { HarnessIcon } from "../shared/HarnessIcon";
import {
  CollapsibleRegion,
  ExecutionStateBadge,
  VirtualizedDropdownList,
} from "../shared";
import {
  WorkflowRowLayout,
  RunIndicatorCell,
  RowActionRail,
  WorkflowRowTrailing,
  WORKFLOW_ROW_CONTAINER_CLASS,
  RowActionButton,
  ScheduleRowActionButton,
  composeRowAccessibleName,
  isCompactRow,
} from "./WorkflowRowLayout";
import {
  WorkflowTokenUsage,
  hasWorkflowTokenUsage,
  workflowTokenTotalsAccessibleLabel,
} from "./WorkflowTokenUsage";
import { RunDuration, runDurationAccessibleLabel } from "./RunDuration";
import {
  WORKFLOW_DROPDOWN_ROW_HEIGHT_ESTIMATE,
  WORKFLOW_ROW_KINDS,
  WORKFLOW_ROW_TIERS,
  WORKFLOW_SCHEDULE_LABELS,
  type WorkflowRowTier,
} from "../../constants";
import { getHarnessDisplayName } from "../../types/messages";
import type { WorkflowSummary } from "../../types/messages";
import type { RecentWorkflow } from "../../store/uiStore";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import type { ExecutionState } from "../../types/messages";
import { areWorkflowAddressesEqual } from "@utils/viewAddress";
import { upcomingScheduleRunAt } from "@utils/workflowScheduleDisplay";
import { isWorkflowActive } from "../../utils/status";
import { getContextMenuOpener, useLongPress } from "@hooks/useLongPress";
import type { WorkflowContextMenuTarget } from "@hooks/useWorkflowContextMenu";
import { Icon } from "../shared/Icon";
import {
  WORKFLOW_LIST_SECTIONS,
  type WorkflowListSection,
} from "@root/types/DashboardConstants";
import { useUiStore } from "../../store/uiStore";

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

/** Imperative handle for saving/restoring the recent-list scroll position across a drill-in/back round trip. */
export interface WorkflowListHandle {
  getScrollOffset: () => number;
  setScrollOffset: (offset: number) => void;
}

interface WorkflowListProps {
  rows: UnifiedWorkflowRow[];
  scheduledWorkflows?: RecentWorkflow[];
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
  onEditSchedule?: (
    target: WorkflowContextMenuTarget,
    opener: HTMLElement | null
  ) => void;
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
  /** The host has not answered GET_RECENT_WORKFLOWS yet; an empty recent region is pending, not empty. */
  isLoadingRecent?: boolean;
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
  onEditSchedule?: (
    target: WorkflowContextMenuTarget,
    opener: HTMLElement | null
  ) => void;
  onRemove?: (address: WorkflowViewAddress) => void;
  onDrillIntoRuns?: (workflow: RecentWorkflow) => void;
  onOpenContextMenu?: (
    x: number,
    y: number,
    target: WorkflowContextMenuTarget,
    opener?: HTMLElement | null
  ) => void;
  /** Row sits in the Scheduled section: its metadata shows the next run instead of the last activity. */
  scheduled?: boolean;
}

/**
 * Height cap for an expanded pinned section while history rows sit beneath
 * it. Two expanded sections share less each, so history always keeps at
 * least ~40% of the dropdown. Literal class strings so Tailwind emits them.
 */
const PINNED_SECTION_CAP_CLASS = {
  alone: "shrink-0 max-h-[min(260px,50%)]",
  shared: "shrink-0 max-h-[min(260px,30%)]",
} as const;

interface PinnedSectionHeaderProps {
  section: WorkflowListSection;
  icon: string;
  label: string;
  count: number;
  collapsed: boolean;
  listId: string;
}

/** Caption of a pinned dropdown section; clicking it collapses or expands the section. */
const PinnedSectionHeader: React.FC<PinnedSectionHeaderProps> = ({
  section,
  icon,
  label,
  count,
  collapsed,
  listId,
}) => {
  const toggle = useUiStore((s) => s.toggleWorkflowListSectionCollapsed);
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-controls={listId}
      title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      onClick={() => toggle(section)}
      className="flex w-full shrink-0 items-center gap-1.5 px-3 pt-1.5 pb-0.5 text-left text-xxs font-semibold uppercase tracking-wider text-description-fg hover:text-foreground"
    >
      <Icon name={collapsed ? "chevron-right" : "chevron-down"} />
      <Icon name={icon} />
      <span>
        {label} ({count})
      </span>
    </button>
  );
};

const RecentWorkflowRow: React.FC<RecentWorkflowRowProps> = ({
  workflow,
  currentAddress,
  hasActiveTerminal,
  tier,
  onSelect,
  onToggleFavorite,
  onEditSchedule,
  onRemove,
  onDrillIntoRuns,
  onOpenContextMenu,
  scheduled = false,
}) => {
  const isCurrent = areWorkflowAddressesEqual(workflow.address, currentAddress);
  const showTerminalIcon = hasActiveTerminal?.(workflow) ?? false;
  const showStepCount =
    typeof workflow.totalSteps === "number" && workflow.totalSteps > 0;
  const upcomingRunAt = scheduled
    ? upcomingScheduleRunAt(workflow, Date.now())
    : null;
  const timeAgo = scheduled
    ? !workflow.schedule?.enabled
      ? WORKFLOW_SCHEDULE_LABELS.pausedNextRun
      : upcomingRunAt !== null
        ? `${WORKFLOW_SCHEDULE_LABELS.nextRun}: ${new Date(upcomingRunAt).toLocaleString()}`
        : WORKFLOW_SCHEDULE_LABELS.noNextRun
    : formatRelativeTimeVerbose(workflow.lastModifiedAt || workflow.startedAt);
  const accessibleName = composeRowAccessibleName([
    workflow.workflowName,
    workflow.executionState,
    showStepCount &&
      `${workflow.totalSteps} step${workflow.totalSteps === 1 ? "" : "s"}`,
    workflowTokenTotalsAccessibleLabel(workflow.tokenTotals),
    runDurationAccessibleLabel(workflow.activeExecutionMs),
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
        schedule: workflow.schedule,
        scheduleNextRunAt: workflow.scheduleNextRunAt,
        scheduleLastMissedAt: workflow.scheduleLastMissedAt,
        scheduleOnOtherHost: workflow.scheduleOnOtherHost,
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
      className={`workflow-menu-item ${WORKFLOW_ROW_CONTAINER_CLASS} group text-left text-sm transition-colors ${
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
          workflow.harness ? getHarnessDisplayName(workflow.harness) : undefined
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
        duration={
          workflow.activeExecutionMs !== undefined ? (
            <RunDuration durationMs={workflow.activeExecutionMs} />
          ) : undefined
        }
        time={
          timeAgo ? (
            <span className="workflow-menu-item-time">{timeAgo}</span>
          ) : undefined
        }
      />

      {/* Run indicator — sibling of the primary button, not inside it.
        Drills into the run panel without selecting/loading the lineage. */}
      <RunIndicatorCell
        runNav={workflow.runNav}
        workflowName={workflow.workflowName}
        onDrill={onDrillIntoRuns ? () => onDrillIntoRuns(workflow) : undefined}
      />

      <WorkflowRowTrailing>
        <RowActionRail>
          <ScheduleRowActionButton
            schedule={workflow.schedule}
            scheduleNextRunAt={workflow.scheduleNextRunAt}
            onOpen={(opener) =>
              onEditSchedule?.(
                {
                  address: workflow.address,
                  workflowName: workflow.workflowName,
                  scope: "lineage",
                  isFavorite: workflow.isFavorite,
                  schedule: workflow.schedule,
                  scheduleNextRunAt: workflow.scheduleNextRunAt,
                  scheduleLastMissedAt: workflow.scheduleLastMissedAt,
                  scheduleOnOtherHost: workflow.scheduleOnOtherHost,
                  runDirectory: workflow.runDirectory,
                  isExecuting: false,
                  isUnstarted: workflow.unstarted,
                },
                opener
              )
            }
          />
          {onToggleFavorite && (
            <RowActionButton
              icon={
                workflow.isFavorite ? "codicon-star-full" : "codicon-star-empty"
              }
              title={
                workflow.isFavorite
                  ? "Remove from favorites"
                  : "Add to favorites"
              }
              onClick={() => onToggleFavorite(workflow.address)}
              revealOnHover={!workflow.isFavorite}
              toneClassName={
                workflow.isFavorite
                  ? "text-favorite hover:opacity-80"
                  : "text-description-fg hover:text-favorite"
              }
            />
          )}
          {onRemove && (
            <RowActionButton
              icon="trash"
              title="Remove from history"
              onClick={() => onRemove(workflow.address)}
              revealOnHover
              toneClassName="text-description-fg hover:text-error-fg"
            />
          )}
        </RowActionRail>
      </WorkflowRowTrailing>
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
    scheduledWorkflows = [],
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
    onEditSchedule,
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
    isLoadingRecent = false,
    tier = WORKFLOW_ROW_TIERS.STACKED,
    className = "",
  },
  ref
) {
  const runningScrollContainerRef = useRef<HTMLDivElement>(null);
  const scheduledScrollContainerRef = useRef<HTMLDivElement>(null);
  const collapsedSections = useUiStore((s) => s.collapsedWorkflowListSections);
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
  const scheduleNow = Date.now();
  // Favourites first, as in history, then soonest next run.
  const orderedScheduledWorkflows = [...scheduledWorkflows].sort(
    (a, b) =>
      Number(b.isFavorite ?? false) - Number(a.isFavorite ?? false) ||
      (upcomingScheduleRunAt(a, scheduleNow) ?? Number.MAX_SAFE_INTEGER) -
        (upcomingScheduleRunAt(b, scheduleNow) ?? Number.MAX_SAFE_INTEGER)
  );
  const hasScheduledRows = orderedScheduledWorkflows.length > 0;
  const runningCollapsed = collapsedSections.includes(
    WORKFLOW_LIST_SECTIONS.RUNNING
  );
  const scheduledCollapsed = collapsedSections.includes(
    WORKFLOW_LIST_SECTIONS.SCHEDULED
  );
  const runningExpanded = hasRunningRows && !runningCollapsed;
  const scheduledExpanded = hasScheduledRows && !scheduledCollapsed;
  const pinnedCapClass =
    runningExpanded && scheduledExpanded
      ? PINNED_SECTION_CAP_CLASS.shared
      : PINNED_SECTION_CAP_CLASS.alone;
  // A collapsed section is just its caption; an expanded one is capped while
  // history rows sit beneath it, and otherwise takes the free space.
  const pinnedRegionClass = (expanded: boolean) =>
    `cy-collapsible-cap ${
      !expanded ? "shrink-0" : hasRecentRows ? pinnedCapClass : "flex-1 min-h-0"
    }`;
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

      {/* Pinned running and scheduled regions — content-sized up to a cap
          (PINNED_SECTION_CAP_CLASS) so a handful of rows cost only their own
          height while a large count scrolls internally instead of crowding
          out the recent list. The percentage resolves because the dropdown is
          fixed-positioned with a definite height. When the recent region is
          empty the cap lifts (flex-1) so pinned rows can use the free space.
          Either section collapses to its caption. */}
      {hasRunningRows && (
        <div
          role="region"
          aria-label="Running workflows"
          className={`running-workflows-region flex flex-col border-b border-dropdown-border ${pinnedRegionClass(
            runningExpanded
          )}`}
        >
          <PinnedSectionHeader
            section={WORKFLOW_LIST_SECTIONS.RUNNING}
            icon="debug-line-by-line"
            label="Running"
            count={runningRows.length}
            collapsed={runningCollapsed}
            listId="workflow-list-running"
          />
          <CollapsibleRegion
            id="workflow-list-running"
            collapsed={runningCollapsed}
            className="min-h-0 flex-1"
          >
            <div
              ref={runningScrollContainerRef}
              role="list"
              aria-label="Running workflows"
              className="running-workflow-items overflow-y-auto overflow-x-clip pb-1"
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
                    hasActiveTerminal={runningHasActiveTerminal(
                      row.workflow.id
                    )}
                    tier={tier}
                    runNav={row.lineage?.runNav}
                    lineage={row.lineage}
                    onDrillIntoRuns={
                      row.lineage && onDrillIntoRuns
                        ? () => onDrillIntoRuns(row.lineage!)
                        : undefined
                    }
                    onOpenContextMenu={onOpenContextMenu}
                    onEditSchedule={onEditSchedule}
                    onClick={() => onSwitchRunning(row.workflow.id)}
                    onPause={() => onPauseRunning(row.workflow)}
                    onCancelPause={() => onCancelPauseRunning(row.workflow)}
                    onResume={() => onResumeRunning(row.workflow)}
                    onStop={() => onStopRunning(row.workflow)}
                  />
                )}
              />
            </div>
          </CollapsibleRegion>
        </div>
      )}

      {hasScheduledRows && (
        <div
          role="region"
          aria-label="Scheduled workflows"
          className={`scheduled-workflows-region flex flex-col border-b border-dropdown-border ${pinnedRegionClass(
            scheduledExpanded
          )}`}
        >
          <PinnedSectionHeader
            section={WORKFLOW_LIST_SECTIONS.SCHEDULED}
            icon="clock"
            label="Scheduled"
            count={orderedScheduledWorkflows.length}
            collapsed={scheduledCollapsed}
            listId="workflow-list-scheduled"
          />
          <CollapsibleRegion
            id="workflow-list-scheduled"
            collapsed={scheduledCollapsed}
            className="min-h-0 flex-1"
          >
            <div
              ref={scheduledScrollContainerRef}
              role="list"
              aria-label="Scheduled workflows"
              className="overflow-y-auto overflow-x-clip pb-1"
            >
              <VirtualizedDropdownList
                items={orderedScheduledWorkflows}
                getItemKey={(workflow) =>
                  `scheduled:${workflow.address.workflowKey}`
                }
                scrollContainerRef={scheduledScrollContainerRef}
                estimatedRowHeight={estimatedRowHeight}
                renderItem={(workflow) => (
                  <RecentWorkflowRow
                    workflow={workflow}
                    currentAddress={currentAddress}
                    hasActiveTerminal={recentHasActiveTerminal}
                    tier={tier}
                    onSelect={onSelectRecent}
                    onToggleFavorite={onToggleFavorite}
                    onEditSchedule={onEditSchedule}
                    onRemove={onRemove}
                    onDrillIntoRuns={onDrillIntoRuns}
                    onOpenContextMenu={onOpenContextMenu}
                    scheduled
                  />
                )}
              />
            </div>
          </CollapsibleRegion>
        </div>
      )}

      {/* Recent workflows — scrolls independently of the pinned running
          region, so running lineages stay reachable at any scroll depth */}
      <div
        ref={recentScrollContainerRef}
        role="list"
        aria-label="Recent workflows"
        className={`workflow-menu-items overflow-y-auto overflow-x-clip py-1 ${
          hasRecentRows || (!runningExpanded && !scheduledExpanded)
            ? "flex-1 min-h-0"
            : "shrink-0"
        }`}
      >
        {/* With no recent rows: a pending history shows a loading row, even
            beneath running rows — otherwise a running workflow reads as the
            whole history until the slow lineage scan answers. Once loaded,
            running matches fill the pinned region above, so an empty recent
            region then needs neither a "no match" message nor a New Workflow
            prompt while workflows are actively running. */}
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
                onEditSchedule={onEditSchedule}
                onRemove={onRemove}
                onDrillIntoRuns={onDrillIntoRuns}
                onOpenContextMenu={onOpenContextMenu}
              />
            )}
          />
        ) : isLoadingRecent ? (
          <div
            role="status"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-description-fg"
          >
            <Icon name="loading" className="codicon-modifier-spin" />
            Loading workflows…
          </div>
        ) : hasRunningRows || hasScheduledRows ? null : isFiltering ? (
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
