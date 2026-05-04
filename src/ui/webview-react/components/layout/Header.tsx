import React, { useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  RUNNER_IDS,
} from "../../types/messages";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useIsMobile } from "@hooks/useMediaQuery";
import { WebviewLog } from "@utils/logger";
import { WorkflowControls } from "../workflow/WorkflowControls";
import { WorkflowStatus } from "../workflow/WorkflowStatus";
import { SaveWorkflowDialog } from "../workflow/SaveWorkflowDialog";
import { TemplateModal } from "../workflow/TemplateModal";
import { UndoRedoControl } from "../shared/UndoRedoControl";
import { HEADER_BUTTON_SIZES } from "../../constants";

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
  [EXECUTION_STATES.PAUSING]: {
    icon: "debug-pause",
    text: "Pausing",
    className:
      "bg-[var(--status-warning)] text-[var(--btn-fg)] animate-pulse-cancelling",
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
 *   Wide:   [WorkflowControls + grouped editing buttons] [WorkflowStatus (centered)] [Run/Pause/Stop]
 *   Narrow: [WorkflowControls] [Grouped editing buttons (centered)] [Run/Pause/Stop (right)]
 *           [[Steps]            [WorkflowStatus (centered)]    [Workflow Properties]]   ← mobile only
 * Features:
 * - WorkflowControls: Split button for New/Load/Queue workflow actions
 * - WorkflowStatus: Workflow name + execution state badge (editable name, recent workflows dropdown)
 * - Control buttons: Run/Pause/Stop based on execution state
 */
export const Header: React.FC<{
  onToggleMobileSteps?: () => void;
  onToggleMobileWorkflowProps?: () => void;
}> = ({ onToggleMobileSteps, onToggleMobileWorkflowProps }) => {
  const vscode = useVsCodeApi();
  const isMobile = useIsMobile();
  const btnSize = isMobile
    ? HEADER_BUTTON_SIZES.touch
    : HEADER_BUTTON_SIZES.default;
  const openWorkspaceViewer = useWorkspaceViewerStore((s) => s.open);
  const { fileName, executionState, currentStep } = useWorkflowStore();
  const hasPrompts = useWorkflowStore((s) => s.steps.length > 0);
  const {
    loadedWorkflows,
    activeWorkflowId,
    activeWorkflowWorkingFilePath,
    newWorkflowModalOpen,
    closeNewWorkflowModal,
    mobileStepsOpen,
    mobileWorkflowPropsOpen,
    globalSettingsOpen,
    toggleGlobalSettings,
  } = useUiStore();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy ===
    RUNNER_IDS.CLI;

  // Derived state
  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const isPausing = executionState === EXECUTION_STATES.PAUSING;
  const isPaused = executionState === EXECUTION_STATES.PAUSED;
  const isCompleted = executionState === EXECUTION_STATES.COMPLETED;
  const isError = executionState === EXECUTION_STATES.ERROR;
  const isStopped = executionState === EXECUTION_STATES.STOPPED;
  const isCancelling = executionState === EXECUTION_STATES.CANCELLING;
  const isIdle = executionState === EXECUTION_STATES.IDLE;
  // True when user stopped then used "set start position" — idle but not at step 0
  const isIdleWithOffset = isIdle && currentStep > 0;
  const hasFile = fileName !== null;

  // Button enable states
  // Enable Run button if: has file AND (not running OR is completed OR is paused OR is stopped)
  // Disable during cancellation - must wait for process to fully stop
  // When paused/stopped/completed, Run button acts as "Restart from beginning"
  const canRun =
    hasFile &&
    !isCancelling &&
    !(isRunning && !isCompleted && !isPaused && !isStopped) &&
    !isPausing;

  // Pause button becomes resume button when paused, stopped, errored, or idle-with-offset.
  // Disable during cancellation.
  // PAUSING: Clicking again cancels the pending pause (returns to RUNNING)
  // PAUSED: Resumes to next prompt (current one completed normally)
  // STOPPED: Resumes to next prompt (cancelled prompt already advanced past)
  // ERROR: Retries the current prompt from the beginning
  // IDLE+offset: User stopped then set start position — resume from the repositioned step
  const canPause = isRunning && !isCancelling;
  const canCancelPause = isPausing && !isCancelling;
  const canResume = isPaused || isStopped || isError || isIdleWithOffset;

  // Stop button enabled when running, pausing, paused, or cancelling (allow re-pressing Stop to see status)
  // Disable when stopped (already stopped)
  const canStop = isRunning || isPausing || isPaused || isCancelling;

  // Run button shows restart icon when paused, stopped, completed, or errored
  const isRerun = isCompleted || isError || isPaused || isStopped;

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
    if (activeWorkflowId) {
      vscode.postMessage({
        type: MESSAGE_TYPES.RUN_WORKFLOW,
        workflowId: activeWorkflowId,
      });
    } else {
      vscode.postMessage({ type: MESSAGE_TYPES.RUN });
    }
  }, [vscode, canRun, activeWorkflowId]);

  const handlePauseResume = useCallback(() => {
    if (isPaused || isStopped || isError || isIdleWithOffset) {
      if (activeWorkflowId) {
        vscode.postMessage({
          type: MESSAGE_TYPES.RESUME_WORKFLOW,
          workflowId: activeWorkflowId,
          workingFilePath: activeWorkflowWorkingFilePath ?? undefined,
        });
      } else {
        vscode.postMessage({ type: MESSAGE_TYPES.RESUME });
      }
    } else if (canCancelPause) {
      if (activeWorkflowId) {
        vscode.postMessage({
          type: MESSAGE_TYPES.CANCEL_PAUSE_WORKFLOW,
          workflowId: activeWorkflowId,
        });
      }
    } else if (canPause) {
      if (activeWorkflowId) {
        vscode.postMessage({
          type: MESSAGE_TYPES.PAUSE_WORKFLOW,
          workflowId: activeWorkflowId,
        });
      } else {
        vscode.postMessage({ type: MESSAGE_TYPES.PAUSE });
      }
    }
  }, [
    vscode,
    isPaused,
    isStopped,
    isError,
    isIdleWithOffset,
    canCancelPause,
    canPause,
    activeWorkflowId,
    activeWorkflowWorkingFilePath,
  ]);

  const handleStop = useCallback(() => {
    if (!canStop) return;
    if (activeWorkflowId) {
      vscode.postMessage({
        type: MESSAGE_TYPES.STOP_WORKFLOW,
        workflowId: activeWorkflowId,
      });
    } else {
      vscode.postMessage({ type: MESSAGE_TYPES.STOP });
    }
  }, [vscode, canStop, activeWorkflowId]);

  const handleUndoRedoAction = useCallback(
    (
      action: "undo-click" | "redo-click" | "history-toggle" | "history-jump",
      details: {
        canUndo: boolean;
        canRedo: boolean;
        pastCount: number;
        futureCount: number;
        editingDisabled: boolean;
        historyEntryCount: number;
        isOpen?: boolean;
        undoCount?: number;
      }
    ) => {
      WebviewLog.debug(`[Header] ${action}`, {
        executionState,
        isRunning,
        isPaused,
        isStopped,
        isCancelling,
        ...details,
      });
    },
    [executionState, isCancelling, isPaused, isRunning, isStopped]
  );

  return (
    <>
      <header className="header grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_minmax(0,1fr)_1fr] gap-x-1 sm:gap-x-4 gap-y-1.5 items-center sm:px-3 py-1.5 border-b border-panel-border bg-sidebar-bg flex-shrink-0 overflow-visible">
        {/* Left Section: Workflow Controls + grouped editing buttons */}
        <div className="header-left flex items-center gap-1 sm:gap-2 pl-1 sm:pl-0">
          <WorkflowControls />
          {/* Grouped Editing Buttons */}
          <div
            className={`fp-button-group ${btnSize.groupContainer}`}
            role="group"
            aria-label="Workflow editing controls"
          >
            {/* Save button */}
            <button
              className={`control-button flex items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
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
              <i className={`codicon codicon-save ${btnSize.icon}`} />
            </button>

            <div className="fp-button-group-divider" />

            {/* Undo / Redo / History */}
            <UndoRedoControl
              isRunning={isRunning}
              isPaused={isPaused}
              embedded
              onAction={handleUndoRedoAction}
            />

            <div className="fp-button-group-divider" />

            {/* Workspace Explorer button — standalone (browser) mode only */}
            {isStandalone && (
              <>
                <button
                  className={`control-button flex items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover`}
                  onClick={openWorkspaceViewer}
                  title="Explore files and changes"
                  aria-label="Explore files and changes"
                >
                  <i className={`codicon codicon-files ${btnSize.icon}`} />
                </button>

                <div className="fp-button-group-divider" />
              </>
            )}

            {/* Settings button */}
            <button
              className={`control-button flex items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
                globalSettingsOpen ? "fp-contrast-active " : ""
              }${
                globalSettingsOpen
                  ? "bg-btn-bg text-btn-fg hover:bg-btn-hover"
                  : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              }`}
              onClick={toggleGlobalSettings}
              title="Global Settings"
              aria-label="Open global settings"
              aria-pressed={globalSettingsOpen}
            >
              <i className={`codicon codicon-settings-gear ${btnSize.icon}`} />
            </button>
          </div>
        </div>

        {/* Save Workflow Dialog — rendered here for co-location with SaveWorkflowButton */}
        <SaveWorkflowDialog />

        {/* Template Modal — controlled by uiStore.newWorkflowModalOpen */}
        <TemplateModal
          isOpen={newWorkflowModalOpen}
          onClose={closeNewWorkflowModal}
        />

        {/* Center Section: Workflow Status - own row on narrow, perfectly centered on wide via 1fr/auto/1fr grid */}
        <div className="header-center order-last sm:order-none col-span-2 sm:col-span-1 justify-self-center w-full flex items-center justify-center min-w-0 gap-1">
          {isMobile && (
            <button
              className={`control-button flex items-center justify-center mr-2 gap-0.5 pl-3.5 pr-2 ${btnSize.mobileToggleButton} rounded-r border-y border-r border-btn-border transition-colors ${
                mobileStepsOpen ? "fp-contrast-active " : ""
              }${
                mobileStepsOpen
                  ? "bg-btn-bg text-btn-fg"
                  : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              }`}
              onClick={onToggleMobileSteps}
              title="Steps"
              aria-label="Toggle steps panel"
              aria-pressed={mobileStepsOpen}
            >
              <i className={`codicon codicon-list-ordered ${btnSize.icon}`} />
            </button>
          )}
          <WorkflowStatus className="flex-1 sm:max-w-[500px]" />
          {isMobile && (
            <button
              className={`control-button flex items-center justify-center ml-2 gap-0.5 pl-2 pr-3.5 ${btnSize.mobileToggleButton} rounded-l border-y border-l border-btn-border transition-colors ${
                mobileWorkflowPropsOpen ? "fp-contrast-active " : ""
              }${
                mobileWorkflowPropsOpen
                  ? "bg-btn-bg text-btn-fg"
                  : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              }`}
              onClick={onToggleMobileWorkflowProps}
              title="Workflow Properties"
              aria-label="Toggle workflow properties"
              aria-pressed={mobileWorkflowPropsOpen}
            >
              <i className={`codicon codicon-settings ${btnSize.icon}`} />
            </button>
          )}
        </div>

        {/* Right Section: Control Buttons */}
        <div className="header-right justify-self-end flex items-center pr-1 sm:pr-0">
          <div
            className={`fp-button-group ${btnSize.groupContainer}`}
            role="group"
            aria-label="Workflow execution controls"
          >
            {/* Run/Restart Button (icon-only) */}
            <button
              className={`control-button items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
                isRerun ? "font-bold" : ""
              } ${
                canRun && !isCLIManaged
                  ? "flex bg-btn-bg text-btn-fg hover:bg-btn-hover"
                  : "hidden sm:flex bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
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
                className={`codicon ${isRerun ? "codicon-refresh" : "codicon-debug-start"} ${btnSize.icon}`}
              />
            </button>

            <div
              className={`fp-button-group-divider ${canRun && !isCLIManaged && (canPause || canCancelPause || canResume) ? "" : "hidden sm:block"}`}
            />

            {/* Pause/Resume Button */}
            <button
              className={`control-button items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
                (canPause || canCancelPause || canResume) && !isCLIManaged
                  ? "flex bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                  : "hidden sm:flex bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
              }`}
              onClick={handlePauseResume}
              disabled={
                (!canPause && !canCancelPause && !canResume) || isCLIManaged
              }
              title={
                isCLIManaged
                  ? "Workflow is running via FlightPath CLI"
                  : isPaused
                    ? "Resume"
                    : isStopped
                      ? "Resume"
                      : isError
                        ? "Continue (retry current prompt)"
                        : isIdleWithOffset
                          ? "Resume from start position"
                          : isPausing
                            ? "Cancel pause"
                            : "Pause after current step completes"
              }
              aria-label={
                isPaused || isStopped || isError || isIdleWithOffset
                  ? "Resume"
                  : isPausing
                    ? "Cancel pause"
                    : "Pause"
              }
            >
              <i
                className={`codicon ${
                  isPaused || isStopped || isError || isIdleWithOffset
                    ? "codicon-debug-continue"
                    : isPausing
                      ? "codicon-debug-pause animate-pulse-cancelling"
                      : "codicon-debug-pause"
                } ${btnSize.icon}`}
              />
            </button>

            <div
              className={`fp-button-group-divider ${(canPause || canCancelPause || canResume) && !isCLIManaged && (canStop || isCLIManaged) ? "" : "hidden sm:block"}`}
            />

            {/* Stop Button */}
            <button
              className={`control-button items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
                canStop || isCLIManaged
                  ? "flex bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
                  : "hidden sm:flex bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
              }`}
              onClick={isCLIManaged ? handleStopCliRun : handleStop}
              disabled={!canStop && !isCLIManaged}
              title={isCLIManaged ? "Stop CLI run" : "Stop immediately"}
              aria-label="Stop"
            >
              <i className={`codicon codicon-debug-stop ${btnSize.icon}`} />
            </button>
          </div>
        </div>
      </header>
      {isPausing && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-[var(--status-warning)] text-[var(--btn-fg)] border-b border-btn-border">
          <i className="codicon codicon-debug-pause animate-pulse-cancelling" />
          <span>Workflow will pause after the current step completes</span>
          <button
            className="ml-auto text-xs underline opacity-80 hover:opacity-100"
            onClick={handlePauseResume}
            aria-label="Cancel pause"
          >
            Cancel
          </button>
        </div>
      )}
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
      <i className={`codicon codicon-${config.icon} text-sm`} />
      <span className="execution-state-text">{config.text}</span>
    </span>
  );
};
