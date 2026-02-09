import React, { useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES, EXECUTION_STATES } from "../../types/messages";
import { WorkflowControls } from "../workflow/WorkflowControls";
import { WorkflowStatus } from "../workflow/WorkflowStatus";

/**
 * Execution state badge configuration
 */
interface StateBadgeConfig {
  icon: string;
  text: string;
  className: string;
}

const STATE_BADGE_CONFIG: Record<string, StateBadgeConfig> = {
  [EXECUTION_STATES.IDLE]: {
    icon: "circle-outline",
    text: "Idle",
    className: "bg-exec-idle-bg text-exec-idle-fg",
  },
  [EXECUTION_STATES.RUNNING]: {
    icon: "play",
    text: "Running",
    className: "bg-exec-running-bg text-[var(--btn-fg)] animate-pulse-custom",
  },
  [EXECUTION_STATES.PAUSED]: {
    icon: "debug-pause",
    text: "Paused",
    className: "bg-[var(--status-warning)] text-[var(--btn-fg)]",
  },
  [EXECUTION_STATES.STOPPED]: {
    icon: "circle-slash",
    text: "Stopped",
    className: "bg-exec-stopped-bg text-[var(--btn-fg)]",
  },
  [EXECUTION_STATES.CANCELLING]: {
    icon: "close",
    text: "Cancelling",
    className: "bg-[var(--status-warning)] text-[var(--btn-fg)] animate-pulse-cancelling",
  },
  [EXECUTION_STATES.COMPLETED]: {
    icon: "check",
    text: "Completed",
    className: "bg-[var(--status-success)] text-[var(--btn-fg)]",
  },
  [EXECUTION_STATES.ERROR]: {
    icon: "error",
    text: "Error",
    className: "bg-[var(--status-error)] text-[var(--btn-fg)]",
  },
};

/**
 * Header Component
 *
 * Layout: Left (WorkflowControls) | Center (WorkflowStatus) | Right (Control buttons + Settings)
 *
 * Features:
 * - WorkflowControls: Split button for New/Load/Queue workflow actions
 * - WorkflowStatus: Workflow name + execution state badge (editable name, recent workflows dropdown)
 * - Control buttons: Run/Pause/Stop based on execution state
 */
export const Header: React.FC = () => {
  const vscode = useVsCodeApi();
  const { fileName, executionState } = useWorkflowStore();

  // Derived state
  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const isPaused = executionState === EXECUTION_STATES.PAUSED;
  const isCompleted = executionState === EXECUTION_STATES.COMPLETED;
  const isStopped = executionState === EXECUTION_STATES.STOPPED;
  const isCancelling = executionState === EXECUTION_STATES.CANCELLING;
  const hasFile = fileName !== null;

  // Button enable states
  // Enable Run button if: has file AND (not running OR is completed OR is paused OR is stopped)
  // Disable during cancellation - must wait for process to fully stop
  // When paused/stopped/completed, Run button acts as "Restart from beginning"
  const canRun =
    hasFile &&
    !isCancelling &&
    !(isRunning && !isCompleted && !isPaused && !isStopped);

  // Pause button becomes resume button when paused or stopped
  // Disable during cancellation
  // PAUSED: Resumes to next prompt (current one completed)
  // STOPPED: Resumes to restart current prompt (cancelled)
  const canPause = isRunning && !isCancelling;
  const canResume = isPaused || isStopped;

  // Stop button enabled when running, paused, or cancelling (allow re-pressing Stop to see status)
  // Disable when stopped (already stopped)
  const canStop = isRunning || isPaused || isCancelling;

  // Run button shows restart icon when paused, stopped, or completed
  const isRerun = isCompleted || isPaused || isStopped;

  // Handlers
  const handleRun = useCallback(() => {
    if (!canRun) return;
    vscode.postMessage({ type: MESSAGE_TYPES.RUN });
  }, [vscode, canRun]);

  const handlePauseResume = useCallback(() => {
    if (isPaused || isStopped) {
      vscode.postMessage({ type: MESSAGE_TYPES.RESUME });
    } else if (canPause) {
      vscode.postMessage({ type: MESSAGE_TYPES.PAUSE });
    }
  }, [vscode, isPaused, isStopped, canPause]);

  const handleStop = useCallback(() => {
    if (!canStop) return;
    vscode.postMessage({ type: MESSAGE_TYPES.STOP });
  }, [vscode, canStop]);

  return (
    <header className="header flex items-center justify-between gap-4 px-3 py-1.5 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)] flex-shrink-0 overflow-visible">
      {/* Left Section: Workflow Controls */}
      <div className="header-left flex items-center gap-2 flex-shrink-0">
        <WorkflowControls />
      </div>

      {/* Center Section: Workflow Status */}
      <div className="header-center flex-1 flex items-center justify-center min-w-0">
        <WorkflowStatus className="max-w-[500px]" />
      </div>

      {/* Right Section: Control Buttons */}
      <div className="header-right flex items-center gap-1 flex-shrink-0">
        {/* Run/Restart Button (icon-only) */}
        <button
          className={`control-button flex items-center justify-center min-w-[28px] px-2 py-1.5 text-sm rounded border border-[var(--vscode-button-border,transparent)] transition-colors ${
            isRerun ? "text-base font-bold" : ""
          } ${
            canRun
              ? "bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
              : "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] opacity-50 cursor-not-allowed"
          }`}
          onClick={handleRun}
          disabled={!canRun}
          title={
            !hasFile
              ? "Load a workflow to run"
              : isRerun
                ? "Restart from beginning"
                : "Run"
          }
          aria-label={isRerun ? "Restart from beginning" : "Run"}
        >
          <i
            className={`codicon ${isRerun ? "codicon-debug-restart" : "codicon-debug-start"}`}
          />
        </button>

        {/* Pause/Resume Button */}
        <button
          className={`control-button flex items-center justify-center min-w-[28px] px-2 py-1.5 text-sm rounded border border-[var(--vscode-button-border,transparent)] transition-colors ${
            canPause || canResume
              ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
              : "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] opacity-50 cursor-not-allowed"
          }`}
          onClick={handlePauseResume}
          disabled={!canPause && !canResume}
          title={
            isPaused
              ? "Resume"
              : isStopped
                ? "Resume (restart current prompt)"
                : "Pause"
          }
          aria-label={isPaused || isStopped ? "Resume" : "Pause"}
        >
          <i
            className={`codicon ${isPaused || isStopped ? "codicon-debug-continue" : "codicon-debug-pause"}`}
          />
        </button>

        {/* Stop Button */}
        <button
          className={`control-button flex items-center justify-center min-w-[28px] px-2 py-1.5 text-sm rounded border border-[var(--vscode-button-border,transparent)] transition-colors ${
            canStop
              ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
              : "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] opacity-50 cursor-not-allowed"
          }`}
          onClick={handleStop}
          disabled={!canStop}
          title="Stop execution"
          aria-label="Stop"
        >
          <i className="codicon codicon-debug-stop" />
        </button>
      </div>
    </header>
  );
};

/**
 * ExecutionStateBadge - Standalone badge component for use elsewhere
 * (Exported for potential reuse in other components)
 */
export const ExecutionStateBadge: React.FC<{
  state: string;
  className?: string;
}> = ({ state, className = "" }) => {
  const config =
    STATE_BADGE_CONFIG[state] || STATE_BADGE_CONFIG[EXECUTION_STATES.IDLE];

  return (
    <span
      className={`execution-state-badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide ${config.className} ${className}`}
    >
      <i className={`codicon codicon-${config.icon} text-[13px]`} />
      <span className="execution-state-text">{config.text}</span>
    </span>
  );
};
