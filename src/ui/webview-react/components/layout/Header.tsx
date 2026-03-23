import React, { useCallback } from "react";
import {
  useWorkflowStore,
  useWorkflowTemporalStore,
} from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES, EXECUTION_STATES } from "../../types/messages";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { WorkflowControls } from "../workflow/WorkflowControls";
import { WorkflowStatus } from "../workflow/WorkflowStatus";
import { SaveWorkflowDialog } from "../workflow/SaveWorkflowDialog";
import { TemplateModal } from "../workflow/TemplateModal";

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
    className:
      "bg-[var(--status-warning)] text-[var(--btn-fg)] animate-pulse-cancelling",
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
 * Layout:
 *   Wide:   [WorkflowControls] | [WorkflowStatus (centered)] | [Run/Pause/Stop]
 *   Narrow: [WorkflowControls (left)]  [Run/Pause/Stop (right)]
 *           [         WorkflowStatus (full-width, centered)        ]
 *
 * Features:
 * - WorkflowControls: Split button for New/Load/Queue workflow actions
 * - WorkflowStatus: Workflow name + execution state badge (editable name, recent workflows dropdown)
 * - Control buttons: Run/Pause/Stop based on execution state
 */
export const Header: React.FC = () => {
  const vscode = useVsCodeApi();
  const { fileName, executionState } = useWorkflowStore();
  const hasPrompts = useWorkflowStore((s) => s.prompts.length > 0);
  const {
    loadedWorkflows,
    activeWorkflowId,
    newWorkflowModalOpen,
    closeNewWorkflowModal,
  } = useUiStore();

  // Undo/redo availability — useWorkflowTemporalStore uses useState+useEffect
  // (not useSyncExternalStore) to avoid React 18 concurrent mode error #185.
  const canUndo = useWorkflowTemporalStore((s) => s.pastStates.length > 0);
  const canRedo = useWorkflowTemporalStore((s) => s.futureStates.length > 0);

  const handleUndo = useCallback(() => {
    useWorkflowStore.temporal.getState().undo();
    const { prompts, finalPrompt } = useWorkflowStore.getState();
    vscode.postMessage({
      type: MESSAGE_TYPES.UNDO_REDO_SYNC,
      prompts,
      finalPrompt,
    });
  }, [vscode]);

  const handleRedo = useCallback(() => {
    useWorkflowStore.temporal.getState().redo();
    const { prompts, finalPrompt } = useWorkflowStore.getState();
    vscode.postMessage({
      type: MESSAGE_TYPES.UNDO_REDO_SYNC,
      prompts,
      finalPrompt,
    });
  }, [vscode]);

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy === "cli";

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

  const handleStopCliRun = useCallback(() => {
    if (activeWorkflowId) {
      vscode.postMessage({
        type: MESSAGE_TYPES.STOP_CLI_RUN,
        workflowId: activeWorkflowId,
      });
    }
  }, [vscode, activeWorkflowId]);

  const canSave = hasFile && hasPrompts;

  const handleSave = useCallback(() => {
    if (!canSave) return;
    vscode.postMessage({ type: MESSAGE_TYPES.SAVE_WORKFLOW_REQUEST });
  }, [vscode, canSave]);

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
    <>
      <header className="header grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_1fr] gap-x-4 gap-y-1.5 items-center px-3 py-1.5 border-b border-panel-border bg-sidebar-bg flex-shrink-0 overflow-visible">
        {/* Left Section: Workflow Controls + Save + Undo/Redo buttons */}
        <div className="header-left flex items-center gap-2">
          <WorkflowControls />
          {/* Save button */}
          <button
            className={`control-button flex items-center justify-center min-w-[28px] px-2 py-1.5 text-sm rounded border border-btn-border transition-colors ${
              canSave
                ? "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                : "bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
            }`}
            onClick={handleSave}
            disabled={!canSave}
            title={
              !hasFile
                ? "Load a workflow to save"
                : !hasPrompts
                  ? "Add prompts to save"
                  : "Save workflow to file"
            }
            aria-label="Save workflow"
          >
            <i className="codicon codicon-save" />
          </button>
          {/* Undo button */}
          <button
            className={`control-button flex items-center justify-center min-w-[28px] px-2 py-1.5 text-sm rounded border border-btn-border transition-colors ${
              canUndo && !isRunning && !isPaused
                ? "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                : "bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
            }`}
            onClick={handleUndo}
            disabled={!canUndo || isRunning || isPaused}
            title="Undo"
            aria-label="Undo"
          >
            <i className="codicon codicon-discard" />
          </button>
          {/* Redo button */}
          <button
            className={`control-button flex items-center justify-center min-w-[28px] px-2 py-1.5 text-sm rounded border border-btn-border transition-colors ${
              canRedo && !isRunning && !isPaused
                ? "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                : "bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
            }`}
            onClick={handleRedo}
            disabled={!canRedo || isRunning || isPaused}
            title="Redo"
            aria-label="Redo"
          >
            <i className="codicon codicon-redo" />
          </button>
        </div>

        {/* Save Workflow Dialog — rendered here for co-location with SaveWorkflowButton */}
        <SaveWorkflowDialog />

        {/* Template Modal — controlled by uiStore.newWorkflowModalOpen */}
        <TemplateModal
          isOpen={newWorkflowModalOpen}
          onClose={closeNewWorkflowModal}
        />

        {/* Center Section: Workflow Status - own row on narrow, perfectly centered on wide via 1fr/auto/1fr grid */}
        <div className="header-center order-last sm:order-none col-span-2 sm:col-span-1 justify-self-center w-full sm:w-auto flex items-center justify-center min-w-0">
          <WorkflowStatus className="w-full sm:max-w-[500px]" />
        </div>

        {/* Right Section: Control Buttons */}
        <div className="header-right justify-self-end flex items-center gap-1">
          {/* Run/Restart Button (icon-only) */}
          <button
            className={`control-button flex items-center justify-center min-w-[28px] px-2 py-1.5 text-sm rounded border border-btn-border transition-colors ${
              isRerun ? "text-base font-bold" : ""
            } ${
              canRun && !isCLIManaged
                ? "bg-btn-bg text-btn-fg hover:bg-btn-hover"
                : "bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
            }`}
            onClick={handleRun}
            disabled={!canRun || isCLIManaged}
            title={
              isCLIManaged
                ? "Workflow is running via FlightPath CLI"
                : !hasFile
                  ? "Load a workflow to run"
                  : isRerun
                    ? "Restart from beginning"
                    : "Run"
            }
            aria-label={isRerun ? "Restart from beginning" : "Run"}
          >
            <i
              className={`codicon ${isRerun ? "codicon-refresh" : "codicon-debug-start"}`}
            />
          </button>

          {/* Pause/Resume Button */}
          <button
            className={`control-button flex items-center justify-center min-w-[28px] px-2 py-1.5 text-sm rounded border border-btn-border transition-colors ${
              (canPause || canResume) && !isCLIManaged
                ? "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                : "bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
            }`}
            onClick={handlePauseResume}
            disabled={(!canPause && !canResume) || isCLIManaged}
            title={
              isCLIManaged
                ? "Workflow is running via FlightPath CLI"
                : isPaused
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
            className={`control-button flex items-center justify-center min-w-[28px] px-2 py-1.5 text-sm rounded border border-btn-border transition-colors ${
              canStop || isCLIManaged
                ? "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                : "bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
            }`}
            onClick={isCLIManaged ? handleStopCliRun : handleStop}
            disabled={!canStop && !isCLIManaged}
            title={isCLIManaged ? "Stop CLI run" : "Stop execution"}
            aria-label="Stop"
          >
            <i className="codicon codicon-debug-stop" />
          </button>
        </div>
      </header>
    </>
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
