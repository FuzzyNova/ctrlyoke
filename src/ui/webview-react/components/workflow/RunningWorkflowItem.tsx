import React from "react";
import {
  EXECUTION_STATES,
  getHarnessDisplayName,
  hasWorkflowStepProgress,
  workflowStepProgressAccessibleLabel,
  workflowStepProgressLabel,
} from "../../types/messages";
import { RunDuration, liveRunDuration } from "./RunDuration";
import type { WorkflowSummary } from "../../types/messages";
import { HarnessIcon } from "../shared/HarnessIcon";
import { ExecutionStateBadge } from "../shared/ExecutionStateBadge";
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
import { type WorkflowRowTier } from "../../constants";
import type { WorkflowRunNavigationSummary } from "@root/types/CtrlYokeTypes";
import type { RecentWorkflow } from "../../store/uiStore";
import type { WorkflowContextMenuTarget } from "@hooks/useWorkflowContextMenu";
import { getContextMenuOpener, useLongPress } from "@hooks/useLongPress";
import { Icon } from "../shared/Icon";
import { workflowRunAddress } from "@utils/viewAddress";
import { applyPauseRequest } from "@utils/status";
import { useIsPauseRequested } from "@store/pauseRequestStore";
import {
  getExternalOwnerBadgeLabel,
  getExternalReadOnlyLabel,
} from "@utils/externalRunner";

interface RunningWorkflowItemProps {
  workflow: WorkflowSummary;
  isCurrent: boolean;
  hasActiveTerminal: boolean;
  tier?: WorkflowRowTier;
  /**
   * Run-navigation summary for this lineage, resolved from the recent-workflow
   * entry it is hidden behind while running. A running lineage's earlier runs
   * are browsable like any other's.
   */
  runNav?: WorkflowRunNavigationSummary;
  lineage?: RecentWorkflow;
  onDrillIntoRuns?: () => void;
  onOpenContextMenu?: (
    x: number,
    y: number,
    target: WorkflowContextMenuTarget,
    opener?: HTMLElement | null
  ) => void;
  onEditSchedule?: (
    target: WorkflowContextMenuTarget,
    opener: HTMLElement | null
  ) => void;
  onClick: () => void;
  onPause: () => void;
  onCancelPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

/**
 * RunningWorkflowItem - Single entry in the running-workflows section.
 *
 * Shows:
 * - Workflow name (truncated)
 * - Optional terminal icon aligned with recent workflow rows
 * - Status badge ("RUNNING" / "PAUSED") aligned with recent workflow rows
 * - Elapsed timer: live ticking for RUNNING, frozen for PAUSED
 *
 * No dismiss button — workflows auto-retire when they finish.
 */
export const RunningWorkflowItem: React.FC<RunningWorkflowItemProps> = ({
  workflow,
  isCurrent,
  hasActiveTerminal,
  tier = "stacked",
  runNav,
  lineage,
  onDrillIntoRuns,
  onOpenContextMenu,
  onEditSchedule,
  onClick,
  onPause,
  onCancelPause,
  onResume,
  onStop,
}) => {
  const runAddress = workflowRunAddress(workflow);
  // A clicked Pause shows as PAUSING until the extension's state update lands.
  const pauseRequested = useIsPauseRequested(runAddress);
  const executionState = applyPauseRequest(
    workflow.executionState,
    pauseRequested
  );
  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const isPausing = executionState === EXECUTION_STATES.PAUSING;
  const isPaused = executionState === EXECUTION_STATES.PAUSED;
  const showStepProgress = hasWorkflowStepProgress(workflow);
  const accessibleName = composeRowAccessibleName([
    workflow.workflowName,
    executionState,
    showStepProgress && workflowStepProgressAccessibleLabel(workflow),
    workflowTokenTotalsAccessibleLabel(workflow.tokenTotals),
    hasActiveTerminal && "terminal session is still running",
  ]);

  const openContextMenu = (
    x: number,
    y: number,
    opener: HTMLElement | null = null
  ) => {
    const address = lineage?.address ?? runAddress;
    if (!address) return;
    onOpenContextMenu?.(
      x,
      y,
      {
        address,
        workflowName: lineage?.workflowName ?? workflow.workflowName,
        scope: "lineage",
        isFavorite: lineage?.isFavorite,
        schedule: lineage?.schedule,
        scheduleNextRunAt: lineage?.scheduleNextRunAt,
        scheduleLastMissedAt: lineage?.scheduleLastMissedAt,
        scheduleOnOtherHost: lineage?.scheduleOnOtherHost,
        runDirectory: lineage?.runDirectory,
        isExecuting: true,
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
      // Padding comes from `.workflow-row`, shared with the recent rows
      // below, so the two regions' columns line up.
      className={`running-workflow-item ${WORKFLOW_ROW_CONTAINER_CLASS} group text-sm transition-colors ${
        isCurrent
          ? "bg-list-active-bg text-list-active-fg font-semibold cy-dropdown-row-selected"
          : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg cy-dropdown-row"
      }`}
      title={workflow.filePath}
    >
      <WorkflowRowLayout
        tier={tier}
        onClick={onClick}
        // Deliberately excludes the run time — it ticks every second, and an
        // accessible name that changes on a timer re-announces the row.
        ariaLabel={accessibleName}
        harness={
          workflow.harness && (
            <HarnessIcon harnessId={workflow.harness} size={14} />
          )
        }
        harnessTitle={
          workflow.harness ? getHarnessDisplayName(workflow.harness) : undefined
        }
        label={<span className="text-sm">{workflow.workflowName}</span>}
        count={
          showStepProgress ? workflowStepProgressLabel(workflow) : undefined
        }
        // The live instance's own projection only — never the lineage's
        // last-persisted snapshot, which can still name a worktree this run
        // stopped using (e.g. the workflow was reconfigured to "none" and
        // resumed on main): a running row must show where this run is
        // actually executing right now, not history.
        worktree={workflow.worktree}
        glyph={
          hasActiveTerminal && (
            <Icon
              name="terminal"
              title="Terminal session is still running"
              aria-label="Terminal session is still running"
            />
          )
        }
        badge={
          <ExecutionStateBadge
            state={executionState}
            isNarrow={isCompactRow(tier)}
          />
        }
        usage={
          hasWorkflowTokenUsage(workflow.tokenTotals) ? (
            <WorkflowTokenUsage totals={workflow.tokenTotals} />
          ) : undefined
        }
        duration={<RunDuration {...liveRunDuration(workflow)} />}
        metaBadge={
          workflow.externalOwner != null ? (
            <span
              className="whitespace-nowrap rounded-sm border border-btn-border bg-btn-bg px-1.5 py-0.5 text-xxs font-semibold text-btn-fg"
              title={getExternalReadOnlyLabel(workflow.externalOwner)}
            >
              {getExternalOwnerBadgeLabel(workflow.externalOwner)}
            </span>
          ) : undefined
        }
      />

      {/* Run indicator — same position as the recent rows', so a running
        lineage's earlier runs stay one click away. */}
      <RunIndicatorCell
        runNav={runNav}
        workflowName={workflow.workflowName}
        onDrill={onDrillIntoRuns}
      />

      <WorkflowRowTrailing>
        {/* Action buttons — pause/stop for locally-owned workflows only; an
          externally-owned row shows its ownership badge in the meta line
          instead (see WorkflowRowLayout's `metaBadge`) and has no local
          controls to offer here. */}
        <RowActionRail>
          <ScheduleRowActionButton
            schedule={lineage?.schedule}
            scheduleNextRunAt={lineage?.scheduleNextRunAt}
            onOpen={(opener) => {
              const address = lineage?.address ?? runAddress;
              if (address)
                onEditSchedule?.(
                  {
                    address,
                    workflowName:
                      lineage?.workflowName ?? workflow.workflowName,
                    scope: "lineage",
                    isFavorite: lineage?.isFavorite,
                    schedule: lineage?.schedule,
                    scheduleNextRunAt: lineage?.scheduleNextRunAt,
                    scheduleLastMissedAt: lineage?.scheduleLastMissedAt,
                    scheduleOnOtherHost: lineage?.scheduleOnOtherHost,
                    runDirectory: lineage?.runDirectory,
                    isExecuting: true,
                  },
                  opener
                );
            }}
          />
          {workflow.externalOwner == null &&
            (isRunning || isPausing || isPaused) && (
              <>
                {isRunning ? (
                  <RowActionButton
                    icon="debug-pause"
                    title="Pause"
                    onClick={onPause}
                    toneClassName="text-description-fg hover:text-foreground"
                  />
                ) : isPausing ? (
                  <RowActionButton
                    icon="debug-continue"
                    title="Cancel pause"
                    onClick={onCancelPause}
                    toneClassName="text-description-fg hover:text-foreground"
                  />
                ) : (
                  <RowActionButton
                    icon="debug-continue"
                    title="Continue"
                    onClick={onResume}
                    toneClassName="text-description-fg hover:text-foreground"
                  />
                )}
                <RowActionButton
                  icon="debug-stop"
                  title="Stop"
                  onClick={onStop}
                  toneClassName="text-description-fg hover:text-error-fg"
                />
              </>
            )}
        </RowActionRail>
      </WorkflowRowTrailing>
    </div>
  );
};
