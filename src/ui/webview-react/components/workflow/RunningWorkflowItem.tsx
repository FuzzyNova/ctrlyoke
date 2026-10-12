import React from "react";
import {
  EXECUTION_STATES,
  HARNESS_INFO,
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
  composeRowAccessibleName,
  isCompactRow,
} from "./WorkflowRowLayout";
import {
  WorkflowTokenUsage,
  hasWorkflowTokenUsage,
  workflowTokenTotalsAccessibleLabel,
} from "./WorkflowTokenUsage";
import type { WorkflowRowTier } from "../../constants";
import type { WorkflowRunNavigationSummary } from "@root/types/CtrlYokeTypes";
import type { RecentWorkflow } from "../../store/uiStore";
import type { WorkflowContextMenuTarget } from "@hooks/useWorkflowContextMenu";
import { getContextMenuOpener, useLongPress } from "@hooks/useLongPress";
import { Icon } from "../shared/Icon";
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
  /** List-scoped: reserve the indicator track whenever any row in either region is drillable. */
  showRunIndicatorTrack?: boolean;
  onDrillIntoRuns?: () => void;
  onOpenContextMenu?: (
    x: number,
    y: number,
    target: WorkflowContextMenuTarget,
    opener?: HTMLElement | null
  ) => void;
  onClick: () => void;
  onPause: () => void;
  onCancelPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

/**
 * RunningWorkflowItem - Single entry in the "Running Workflows" dropdown section.
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
  showRunIndicatorTrack = false,
  onDrillIntoRuns,
  onOpenContextMenu,
  onClick,
  onPause,
  onCancelPause,
  onResume,
  onStop,
}) => {
  const isRunning = workflow.executionState === EXECUTION_STATES.RUNNING;
  const isPausing = workflow.executionState === EXECUTION_STATES.PAUSING;
  const isPaused = workflow.executionState === EXECUTION_STATES.PAUSED;
  const showStepProgress = hasWorkflowStepProgress(workflow);
  const accessibleName = composeRowAccessibleName([
    workflow.workflowName,
    workflow.executionState,
    showStepProgress && workflowStepProgressAccessibleLabel(workflow),
    workflowTokenTotalsAccessibleLabel(workflow.tokenTotals),
    hasActiveTerminal && "terminal session is still running",
  ]);

  const openContextMenu = (
    x: number,
    y: number,
    opener: HTMLElement | null = null
  ) => {
    const address =
      lineage?.address ??
      (workflow.workflowKey && workflow.runRef
        ? {
            workflowKey: workflow.workflowKey,
            kind: "run" as const,
            runRef: workflow.runRef,
          }
        : undefined);
    if (!address) return;
    onOpenContextMenu?.(
      x,
      y,
      {
        address,
        workflowName: lineage?.workflowName ?? workflow.workflowName,
        scope: "lineage",
        isFavorite: lineage?.isFavorite,
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
      // Padding matches the recent rows below exactly — the two regions are
      // separate scroll containers, so any difference in row padding offsets
      // every column between them.
      className={`running-workflow-item group flex items-center gap-2 px-2 py-2 text-sm transition-colors ${
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
          workflow.harness
            ? (HARNESS_INFO[workflow.harness]?.name ?? workflow.harness)
            : undefined
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
            state={workflow.executionState}
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

      {/* Run indicator — same track and position as the recent rows', so a
          running lineage's earlier runs stay one click away and the columns
          to its right line up across both regions. */}
      {showRunIndicatorTrack && (
        <RunIndicatorCell
          runNav={runNav}
          workflowName={workflow.workflowName}
          onDrill={onDrillIntoRuns}
        />
      )}

      {/* Action buttons — pause/stop for locally-owned workflows only; an
          externally-owned row shows its ownership badge in the meta line
          instead (see WorkflowRowLayout's `metaBadge`) and has no local
          controls to offer here. */}
      <RowActionRail>
        {workflow.externalOwner == null &&
          (isRunning || isPausing || isPaused) && (
            <>
              {isRunning ? (
                <button
                  type="button"
                  title="Pause"
                  aria-label="Pause"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPause();
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="p-0.5 rounded-sm text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
                >
                  <Icon name="debug-pause" />
                </button>
              ) : isPausing ? (
                <button
                  type="button"
                  title="Cancel pause"
                  aria-label="Cancel pause"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancelPause();
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="p-0.5 rounded-sm text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
                >
                  <Icon name="debug-continue" />
                </button>
              ) : (
                <button
                  type="button"
                  title="Continue"
                  aria-label="Continue"
                  onClick={(e) => {
                    e.stopPropagation();
                    onResume();
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="p-0.5 rounded-sm text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
                >
                  <Icon name="debug-continue" />
                </button>
              )}

              <button
                type="button"
                title="Stop"
                aria-label="Stop"
                onClick={(e) => {
                  e.stopPropagation();
                  onStop();
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="p-0.5 rounded-sm text-description-fg hover:text-error-fg hover:bg-toolbar-hover-bg transition-colors"
              >
                <Icon name="debug-stop" />
              </button>
            </>
          )}
      </RowActionRail>
    </div>
  );
};
