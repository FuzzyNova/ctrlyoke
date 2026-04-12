import React, { useState, useEffect } from "react";
import { EXECUTION_STATES, RUNNER_IDS } from "../../types/messages";
import type { WorkflowSummary } from "../../types/messages";

interface RunningWorkflowItemProps {
  workflow: WorkflowSummary;
  isCurrent: boolean;
  onClick: () => void;
  onPause: () => void;
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
 * - Status icon: pulsing green dot for RUNNING, pause codicon for PAUSED
 * - Workflow name (truncated)
 * - Status badge ("RUNNING" / "PAUSED", muted text)
 * - Elapsed timer: live ticking for RUNNING, frozen for PAUSED
 *
 * No dismiss button — workflows auto-retire when they finish.
 */
export const RunningWorkflowItem: React.FC<RunningWorkflowItemProps> = ({
  workflow,
  isCurrent,
  onClick,
  onPause,
  onResume,
  onStop,
}) => {
  const isRunning = workflow.executionState === EXECUTION_STATES.RUNNING;
  const isPaused = workflow.executionState === EXECUTION_STATES.PAUSED;

  const [elapsed, setElapsed] = useState(() =>
    formatElapsed(workflow.startedAt)
  );

  useEffect(() => {
    // Always compute immediately when startedAt or state changes
    setElapsed(formatElapsed(workflow.startedAt));

    if (!isRunning) {
      // PAUSED — freeze the display, no interval needed
      return;
    }

    // RUNNING — tick every second
    const interval = setInterval(() => {
      setElapsed(formatElapsed(workflow.startedAt));
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning, workflow.startedAt]);

  return (
    <div
      className={`running-workflow-item w-full flex items-center px-3 py-2 text-sm transition-colors gap-2 cursor-pointer ${
        isCurrent
          ? "bg-list-active-bg text-list-active-fg font-semibold"
          : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg"
      }`}
      onClick={onClick}
      onTouchEnd={(e) => { e.preventDefault(); onClick(); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      title={workflow.filePath}
    >
      {/* Status icon */}
      {isRunning ? (
        <span className="flex-shrink-0 w-4 flex items-center justify-center">
          <span className="inline-block w-2 h-2 rounded-full bg-bash-status-success animate-pulse" />
        </span>
      ) : (
        <span className="flex-shrink-0 w-4 flex items-center justify-center text-description-fg">
          <i className="codicon codicon-debug-pause" />
        </span>
      )}

      {/* Workflow name */}
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm">
        {workflow.workflowName}
      </span>

      {/* Status badge — fixed-width column so "RUNNING"/"PAUSED" align across rows */}
      <span className="text-[11px] text-description-fg flex-shrink-0 uppercase font-semibold w-[52px] text-center">
        {workflow.executionState}
      </span>

      {/* Elapsed time — fixed-width column for consistent m:ss alignment */}
      <span className="text-[11px] text-description-fg flex-shrink-0 font-mono w-[36px] text-right">
        {elapsed}
      </span>

      {/* Action buttons — CLI pill for CLI-managed workflows, pause/stop for VS Code-managed */}
      {workflow.managedBy === RUNNER_IDS.CLI ? (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-600 text-white flex-shrink-0">
          CLI
        </span>
      ) : (
        (isRunning || isPaused) && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {isRunning ? (
              <button
                type="button"
                title="Pause"
                aria-label="Pause"
                onClick={(e) => { e.stopPropagation(); onPause(); }}
                onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); onPause(); }}
                onKeyDown={(e) => e.stopPropagation()}
                className="p-0.5 rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
              >
                <i className="codicon codicon-debug-pause" />
              </button>
            ) : (
              <button
                type="button"
                title="Resume"
                aria-label="Resume"
                onClick={(e) => { e.stopPropagation(); onResume(); }}
                onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); onResume(); }}
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
              onClick={(e) => { e.stopPropagation(); onStop(); }}
              onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); onStop(); }}
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
