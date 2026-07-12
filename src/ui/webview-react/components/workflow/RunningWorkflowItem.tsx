import React, { useState, useEffect } from "react";
import {
  EXECUTION_STATES,
  RUNNER_IDS,
  HARNESS_INFO,
  workflowDisplayStep,
} from "../../types/messages";
import type { WorkflowSummary } from "../../types/messages";
import {
  getExecutionStateBadgeClass,
  getExecutionStateBadgeIcon,
} from "../../utils/status";
import { HarnessIcon } from "../shared/HarnessIcon";

interface RunningWorkflowItemProps {
  workflow: WorkflowSummary;
  isCurrent: boolean;
  hasActiveTerminal: boolean;
  isNarrow?: boolean;
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
function formatElapsed(startedAt: number | undefined): string {
  if (!startedAt) return "0:00";
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
  isNarrow = false,
  onClick,
  onPause,
  onCancelPause,
  onResume,
  onStop,
}) => {
  const isRunning = workflow.executionState === EXECUTION_STATES.RUNNING;
  const isPausing = workflow.executionState === EXECUTION_STATES.PAUSING;
  const isPaused = workflow.executionState === EXECUTION_STATES.PAUSED;

  const [elapsed, setElapsed] = useState(() =>
    formatElapsed(workflow.startedAt)
  );

  useEffect(() => {
    // Always compute immediately when startedAt or state changes
    setElapsed(formatElapsed(workflow.startedAt));

    if (!isRunning && !isPausing) {
      // PAUSED — freeze the display, no interval needed
      return;
    }

    // RUNNING / PAUSING — tick every second
    const interval = setInterval(() => {
      setElapsed(formatElapsed(workflow.startedAt));
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning, isPausing, workflow.startedAt]);

  return (
    <div
      className={`running-workflow-item flex items-center pl-3 pr-5 py-2 text-sm transition-colors gap-2 ${
        isCurrent
          ? "bg-list-active-bg text-list-active-fg font-semibold fp-dropdown-row-selected outline outline-1 outline-dashed outline-contrast-active-border -outline-offset-1"
          : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg fp-dropdown-row"
      }`}
      title={workflow.filePath}
    >
      <button
        type="button"
        onClick={onClick}
        className={`workflow-row-primary workflow-row-primary-running min-w-0 flex-1 appearance-none overflow-hidden border-none bg-transparent p-0 text-left text-inherit cursor-pointer ${isNarrow ? "workflow-row-primary-narrow" : ""}`}
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

        {/* Workflow name */}
        <span className="col-start-2 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm">
          {workflow.workflowName}
        </span>

        {/* Step progress */}
        <span
          className="col-start-3 text-xs text-description-fg font-mono"
          title={
            workflow.totalSteps > 0
              ? `Step ${Math.min(workflowDisplayStep(workflow), workflow.totalSteps)} of ${workflow.totalSteps}`
              : undefined
          }
        >
          {workflow.totalSteps > 0
            ? isNarrow
              ? `${Math.min(workflowDisplayStep(workflow), workflow.totalSteps)}`
              : `${Math.min(workflowDisplayStep(workflow), workflow.totalSteps)}/${workflow.totalSteps}`
            : ""}
        </span>

        <span
          className="col-start-4 w-4 flex items-center justify-center text-description-fg"
          title={
            hasActiveTerminal ? "Terminal session is still running" : undefined
          }
          aria-label={
            hasActiveTerminal ? "Terminal session is still running" : undefined
          }
        >
          {hasActiveTerminal && <i className="codicon codicon-terminal" />}
        </span>

        {/* Status badge — fixed-width column matches recent workflow rows */}
        <span className="col-start-5 flex justify-center">
          <span
            className={`inline-flex items-center text-xs px-1.5 py-px rounded uppercase font-semibold ${getExecutionStateBadgeClass(workflow.executionState)}`}
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

        {/* Elapsed time — fixed-width column for consistent m:ss alignment */}
        <span className="col-start-6 text-xs text-description-fg font-mono w-[36px] text-right">
          {elapsed}
        </span>
      </button>

      {/* Action buttons — CLI pill for CLI-managed workflows, pause/stop for VS Code-managed */}
      {workflow.managedBy === RUNNER_IDS.CLI ? (
        <span className="px-1.5 py-0.5 rounded text-xxs font-semibold bg-btn-bg text-btn-fg border border-btn-border flex-shrink-0">
          CLI
        </span>
      ) : (
        (isRunning || isPausing || isPaused) && (
          <div className="flex items-center gap-1 flex-shrink-0">
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
                title="Resume"
                aria-label="Resume"
                onClick={(e) => {
                  e.stopPropagation();
                  onResume();
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="p-0.5 rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
              >
                <i className="codicon codicon-play" />
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
          </div>
        )
      )}
    </div>
  );
};
