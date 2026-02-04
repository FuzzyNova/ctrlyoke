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
    className: "execution-state-idle",
  },
  [EXECUTION_STATES.RUNNING]: {
    icon: "play",
    text: "Running",
    className: "execution-state-running",
  },
  [EXECUTION_STATES.PAUSED]: {
    icon: "debug-pause",
    text: "Paused",
    className: "execution-state-paused",
  },
  [EXECUTION_STATES.STOPPED]: {
    icon: "circle-slash",
    text: "Stopped",
    className: "execution-state-stopped",
  },
  [EXECUTION_STATES.CANCELLING]: {
    icon: "close",
    text: "Cancelling",
    className: "execution-state-cancelling",
  },
  [EXECUTION_STATES.COMPLETED]: {
    icon: "check",
    text: "Completed",
    className: "execution-state-completed",
  },
  [EXECUTION_STATES.ERROR]: {
    icon: "error",
    text: "Error",
    className: "execution-state-error",
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
  const isIdle = executionState === EXECUTION_STATES.IDLE;
  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const isPaused = executionState === EXECUTION_STATES.PAUSED;
  const isCompleted = executionState === EXECUTION_STATES.COMPLETED;
  const isError = executionState === EXECUTION_STATES.ERROR;
  const isStopped = executionState === EXECUTION_STATES.STOPPED;

  // Button enable states
  const canRun =
    fileName !== null && (isIdle || isCompleted || isError || isStopped);
  const canPause = isRunning;
  const canResume = isPaused;
  const canStop = isRunning || isPaused;

  // Run button shows "Re-run" if completed/error
  const isRerun = isCompleted || isError;

  // Handlers
  const handleRun = useCallback(() => {
    if (!canRun) return;
    vscode.postMessage({ type: MESSAGE_TYPES.RUN });
  }, [vscode, canRun]);

  const handlePause = useCallback(() => {
    if (!canPause) return;
    vscode.postMessage({ type: MESSAGE_TYPES.PAUSE });
  }, [vscode, canPause]);

  const handleResume = useCallback(() => {
    if (!canResume) return;
    vscode.postMessage({ type: MESSAGE_TYPES.RESUME });
  }, [vscode, canResume]);

  const handleStop = useCallback(() => {
    if (!canStop) return;
    vscode.postMessage({ type: MESSAGE_TYPES.STOP });
  }, [vscode, canStop]);

  return (
    <header className="header flex items-center justify-between gap-4 px-3 py-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)] flex-shrink-0 overflow-visible">
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
        {/* Run/Re-run Button */}
        <button
          className={`control-button flex items-center justify-center gap-1 px-3 py-1 h-[26px] text-sm rounded border border-[var(--vscode-button-border,transparent)] transition-colors ${
            canRun
              ? "bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)]"
              : "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] opacity-50 cursor-not-allowed"
          }`}
          onClick={handleRun}
          disabled={!canRun}
          title={
            !fileName
              ? "Load a workflow to run"
              : isRerun
                ? "Re-run workflow from beginning"
                : "Run workflow"
          }
          aria-label={isRerun ? "Re-run workflow" : "Run workflow"}
        >
          <i
            className={`codicon ${isRerun ? "codicon-refresh" : "codicon-debug-start"}`}
          />
          <span className="button-text">{isRerun ? "Re-run" : "Run"}</span>
        </button>

        {/* Pause/Resume Button */}
        <button
          className={`control-button flex items-center justify-center px-2 py-1 h-[26px] text-sm rounded border border-[var(--vscode-button-border,transparent)] transition-colors ${
            canPause || canResume
              ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]"
              : "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] opacity-50 cursor-not-allowed"
          }`}
          onClick={isPaused ? handleResume : handlePause}
          disabled={!canPause && !canResume}
          title={isPaused ? "Resume execution" : "Pause execution"}
          aria-label={isPaused ? "Resume" : "Pause"}
        >
          <i
            className={`codicon ${isPaused ? "codicon-debug-continue" : "codicon-debug-pause"}`}
          />
        </button>

        {/* Stop Button */}
        <button
          className={`control-button flex items-center justify-center px-2 py-1 h-[26px] text-sm rounded border border-[var(--vscode-button-border,transparent)] transition-colors ${
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
