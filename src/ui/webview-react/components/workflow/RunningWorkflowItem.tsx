import React, { useState, useEffect } from "react";
import {
  EXECUTION_STATES,
  RUNNER_IDS,
  HARNESS_INFO,
  workflowDisplayStep,
} from "../../types/messages";
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
 * Format elapsed time as m:ss (e.g. "5:43", "0:07")
 * No leading zero on minutes; leading zero on seconds.
 */
function formatElapsed(elapsedMs: number): string {
  const elapsed = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getElapsedMs(
  executionTimeMs: number | undefined,
  executionTimeUpdatedAt: number | undefined,
  startedAt: number | undefined,
  isActivelyTiming: boolean
): number {
  if (executionTimeMs !== undefined) {
    if (isActivelyTiming && executionTimeUpdatedAt !== undefined) {
      return executionTimeMs + Math.max(0, Date.now() - executionTimeUpdatedAt);
    }
    return executionTimeMs;
  }
  return startedAt ? Math.max(0, Date.now() - startedAt) : 0;
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
  const isActivelyTiming = isRunning || isPausing;

  const [elapsed, setElapsed] = useState(() =>
    formatElapsed(
      getElapsedMs(
        workflow.executionTimeMs,
        workflow.executionTimeUpdatedAt,
        workflow.startedAt,
        isActivelyTiming
      )
    )
  );

  useEffect(() => {
    const updateElapsed = () =>
      setElapsed(
        formatElapsed(
          getElapsedMs(
            workflow.executionTimeMs,
            workflow.executionTimeUpdatedAt,
            workflow.startedAt,
            isActivelyTiming
          )
        )
      );
    updateElapsed();

    if (!isActivelyTiming) {
      // PAUSED — freeze the display, no interval needed
      return;
    }

    // RUNNING / PAUSING — tick every second
    const interval = setInterval(updateElapsed, 1000);

    return () => clearInterval(interval);
  }, [
    isActivelyTiming,
    workflow.executionTimeMs,
    workflow.executionTimeUpdatedAt,
    workflow.startedAt,
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
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the non-focusable row container owns right-click/long-press gestures; native child controls remain focusable */
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
      // Padding matches the recent rows below exactly — the two regions are
      // separate scroll containers, so any difference in row padding offsets
      // every column between them.
      className={`running-workflow-item group flex items-center gap-2 px-2 py-2 text-sm transition-colors ${
        isCurrent
          ? "bg-list-active-bg text-list-active-fg font-semibold fp-dropdown-row-selected"
          : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg fp-dropdown-row"
      }`}
      title={workflow.filePath}
    >
      <WorkflowRowLayout
        tier={tier}
        onClick={onClick}
        // Deliberately excludes `elapsed` — it ticks every second, and an
        // accessible name that changes on a timer re-announces the row.
        ariaLabel={composeRowAccessibleName([
          workflow.workflowName,
          workflow.executionState,
          workflow.totalSteps > 0 &&
            `step ${Math.min(workflowDisplayStep(workflow), workflow.totalSteps)} of ${workflow.totalSteps}`,
          workflowTokenTotalsAccessibleLabel(workflow.tokenTotals),
          hasActiveTerminal && "terminal session is still running",
        ])}
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
          workflow.totalSteps > 0
            ? `${Math.min(workflowDisplayStep(workflow), workflow.totalSteps)}/${workflow.totalSteps}`
            : undefined
        }
        glyph={
          hasActiveTerminal && (
            <i
              className="codicon codicon-terminal"
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
        time={<span className="font-mono">{elapsed}</span>}
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

      {/* Action buttons — CLI pill for CLI-managed workflows, pause/stop for VS Code-managed */}
      <RowActionRail>
        {workflow.managedBy === RUNNER_IDS.CLI ? (
          <span className="rounded border border-btn-border bg-btn-bg px-1.5 py-0.5 text-xxs font-semibold text-btn-fg">
            CLI
          </span>
        ) : (
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
                  className="p-0.5 rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
                >
                  <i className="codicon codicon-debug-pause" />
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
                  className="p-0.5 rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
                >
                  <i className="codicon codicon-debug-continue" />
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
                  className="p-0.5 rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
                >
                  <i className="codicon codicon-debug-continue" />
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
                className="p-0.5 rounded text-description-fg hover:text-error-fg hover:bg-toolbar-hover-bg transition-colors"
              >
                <i className="codicon codicon-debug-stop" />
              </button>
            </>
          )
        )}
      </RowActionRail>
    </div>
  );
};
