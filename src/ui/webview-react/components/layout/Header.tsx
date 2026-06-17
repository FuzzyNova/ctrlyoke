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
import { NavHistoryControls } from "../shared/NavHistoryControls";
import { HEADER_BUTTON_SIZES } from "../../constants";

/**
 * Execution state badge configuration
 */
/**
 * Header Component
 *
 * Button groups (left → right by role):
 *   [action controls] — Save · Undo/Redo (history chevron) — mutate the workflow; sit with WorkflowControls.
 *   [execution]       — Run · Pause/Resume · Stop — the primary controls, centered.
 *   [app navigation]  — Search · Workspace Explorer · Settings — each opens a drawer/overlay; Settings in the corner.
 *
 * Layout (three tiers):
 *   Wide (lg+):     ([WorkflowControls label][action] left) ([forward/back] [WorkflowStatus] [execution] centered tracks) ([app nav] right)  ← one row
 *   Medium (sm–lg): ([WorkflowControls icon][action] left)  ([forward/back][WorkflowStatus][execution] center lane) ([app nav] right)  ← one row
 *   Narrow (< sm):  ([WorkflowControls icon] left) ([WorkflowStatus][execution] centered)                                         ← row 1
 *                   ([Steps]⟵edge [action] left)                    ([app nav] right [Workflow Properties]⟶edge)                 ← row 2
 *
 * Grid: mobile keeps [auto · minmax(0,1fr) · auto], then from sm up the header switches to
 * [auto · minmax(0,1fr) · auto]. At lg+ it returns to a symmetric outer grid
 * [minmax(0,1fr) · auto · minmax(0,1fr)] so the middle region stays page-centered regardless of wider
 * controls on either side. Inside that wide middle region, forward/back, WorkflowStatus, and execution
 * controls each get their own track so the status itself remains perfectly centered and aligned with its
 * dropdown anchor.
 * The action controls (Save · Undo/Redo) render inline with WorkflowControls from sm up, and only drop to
 * the row-2 left group on narrow mobile — rendered in a single location chosen by `isMobile` (one
 * UndoRedoControl instance). Medium and Wide share desktop button sizing (HEADER_BUTTON_SIZES.default),
 * but below lg the WorkflowControls split button stays icon-first (plus + chevron only) to preserve room
 * for the centered status. forward/back (NavHistoryControls, standalone only) is hidden below md. The
 * Steps / Workflow Properties half-pills are edge-anchored drawer pulls living at the outer ends of the
 * row-2 groups (flat edge flush to the screen, rounded toward the interior). The workflow dropdown anchors
 * to the status button's own bottom (not the header's), so it expands directly from the control even with
 * the row-2 controls beneath it.
 *
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
    isHistorySearchOpen,
    toggleGlobalSettings,
    openHistorySearch,
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

  // Action controls — mutate the workflow (Save · Undo/Redo). Rendered in a single location chosen by
  // tier: inline with WorkflowControls from sm up, or in the row-2 group on narrow mobile. History
  // chevron hidden below sm (handled inside UndoRedoControl).
  const actionControls = (
    <div
      className={`fp-button-group ${btnSize.groupContainer}`}
      role="group"
      aria-label="Workflow action controls"
    >
      {/* Save button */}
      <button
        className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
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
        showHistoryChevronOnDesktopOnly="lg"
        onAction={handleUndoRedoAction}
      />
    </div>
  );

  const runControls = (
    <div className="header-run-controls flex items-center flex-shrink-0">
      <div
        className={`fp-button-group ${btnSize.groupContainer}`}
        role="group"
        aria-label="Workflow execution controls"
      >
        <button
          className={`control-button h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
            isRerun ? "font-bold" : ""
          } ${
            canRun && !isCLIManaged
              ? "flex bg-btn-bg text-btn-fg hover:bg-btn-hover"
              : "hidden xs:flex bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
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
          className={`fp-button-group-divider ${canRun && !isCLIManaged && (canPause || canCancelPause || canResume) ? "" : "hidden xs:block"}`}
        />

        <button
          className={`control-button h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
            (canPause || canCancelPause || canResume) && !isCLIManaged
              ? "flex bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              : "hidden xs:flex bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
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
          className={`fp-button-group-divider ${(canPause || canCancelPause || canResume) && !isCLIManaged && (canStop || isCLIManaged) ? "" : "hidden xs:block"}`}
        />

        <button
          className={`control-button h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
            canStop || isCLIManaged
              ? "flex bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              : "hidden xs:flex bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
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
  );

  return (
    <>
      <header className="header grid grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,1fr)_auto] lg:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,500px)_auto_minmax(0,1fr)_auto] gap-x-1 sm:gap-x-1 gap-y-1.5 items-center sm:px-3 py-1.5 border-b-2 border-panel-border bg-sidebar-bg flex-shrink-0 overflow-visible">
        {/* Left Section: Workflow Controls — always top-left (col 1 / row 1) at every tier so the
            workflow picker anchors the corner. From sm up the action controls sit inline here; on
            narrow mobile they drop to the row-2 group (header-actions). */}
        <div className="header-left col-start-1 row-start-1 justify-self-start lg:justify-self-start min-w-0 flex items-center gap-1 sm:gap-2 pl-1 sm:pl-0">
          <WorkflowControls compactUntilLg />
          {!isMobile && actionControls}
        </div>

        {/* Row-2 left group (narrow mobile only): Steps drawer pull + action controls. Spans the full
            width, left-aligned; hidden from sm up where the action controls live with WorkflowControls. */}
        <div className="header-actions col-start-1 col-end-4 row-start-2 justify-self-start sm:hidden flex items-center gap-1 sm:gap-2 pl-1 sm:pl-0">
          {/* Steps drawer pull (mobile only) — flat left edge to the screen, rounded toward content */}
          {isMobile && (
            <button
              className={`control-button flex items-center justify-center gap-0.5 pl-3.5 pr-2 ${btnSize.mobileToggleButton} rounded-r-button border-y border-r border-btn-border transition-colors ${
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
          {isMobile && actionControls}
        </div>

        {/* Save Workflow Dialog — rendered here for co-location with SaveWorkflowButton */}
        <SaveWorkflowDialog />

        {/* Template Modal — controlled by uiStore.newWorkflowModalOpen */}
        <TemplateModal
          isOpen={newWorkflowModalOpen}
          onClose={closeNewWorkflowModal}
        />

        {/* Mobile status row: forward/back + WorkflowStatus. Hidden from sm up, where both controls
            move into the shared center lane so they can negotiate width together. */}
        <div className="header-status col-start-2 row-start-1 justify-self-stretch w-full flex items-center justify-center min-w-0 gap-0 px-1 sm:hidden">
          {!isMobile && <NavHistoryControls className="flex-shrink-0" />}
          <WorkflowStatus className="flex-1 min-w-0" />
        </div>

        {/* Desktop center lane: medium keeps a shared flex row, while lg+ promotes the centered
            region back into dedicated tracks so WorkflowStatus stays perfectly page-centered. */}
        <div className="hidden sm:flex sm:col-start-2 sm:row-start-1 lg:hidden min-w-0 items-center justify-center gap-0">
          <NavHistoryControls className="hidden md:flex flex-shrink-0" />
          <WorkflowStatus className="flex-1 min-w-[200px] max-w-[500px] mr-1" />
          {runControls}
        </div>

        <div className="hidden lg:flex lg:col-start-3 lg:row-start-1 items-center justify-end min-w-0 mr-1">
          <NavHistoryControls className="hidden md:flex flex-shrink-0" />
        </div>

        <div className="hidden lg:flex lg:col-start-4 lg:row-start-1 items-center justify-center min-w-0">
          <WorkflowStatus className="w-full min-w-0 max-w-[500px]" />
        </div>

        <div className="hidden lg:flex lg:col-start-5 lg:row-start-1 items-center justify-start min-w-0 ml-1">
          {runControls}
        </div>

        {/* Mobile run controls stay in their own grid column to keep the narrow row-1 layout compact. */}
        <div className="col-start-3 row-start-1 justify-self-center flex items-center sm:hidden">
          {runControls}
        </div>

        {/* Right Section: App navigation — Search / Workspace Explorer / Settings.
            These all open a drawer (search/settings) or an overlay view (explorer),
            so they live together with Settings parked in the top-right corner.
            Row 1 from sm up; narrow mobile keeps them on row 2 with the Workflow Properties drawer
            pull trailing the group, flush to the screen's right edge. */}
        <div className="header-app-nav col-start-1 col-end-4 row-start-2 justify-self-end sm:col-start-3 sm:col-end-4 sm:row-start-1 lg:col-start-7 lg:col-end-8 lg:justify-self-end min-w-0 flex items-center justify-end pr-1 sm:pr-0">
          <div
            className={`fp-button-group ${btnSize.groupContainer}`}
            role="group"
            aria-label="App navigation controls"
          >
            {/* Search */}
            <button
              className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
                isHistorySearchOpen ? "fp-contrast-active " : ""
              }${
                isHistorySearchOpen
                  ? "bg-btn-bg text-btn-fg hover:bg-btn-hover"
                  : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              }`}
              onClick={openHistorySearch}
              title="Search History (Ctrl+Shift+F)"
              aria-label="Search history"
              aria-pressed={isHistorySearchOpen}
            >
              <i className={`codicon codicon-search ${btnSize.icon}`} />
            </button>

            {/* Workspace Explorer — standalone (browser) mode only */}
            {isStandalone && (
              <>
                <div className="fp-button-group-divider" />
                <button
                  className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover`}
                  onClick={openWorkspaceViewer}
                  title="Explore files and changes"
                  aria-label="Explore files and changes"
                >
                  <i className={`codicon codicon-files ${btnSize.icon}`} />
                </button>
              </>
            )}

            <div className="fp-button-group-divider" />

            {/* Settings button */}
            <button
              className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
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

          {/* Workflow Properties drawer pull (mobile only) — rounded toward content, flat right edge to the screen */}
          {isMobile && (
            <button
              className={`control-button flex items-center justify-center ml-2 gap-0.5 pl-2 pr-3.5 ${btnSize.mobileToggleButton} rounded-l-button border-y border-l border-btn-border transition-colors ${
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
