import React, { useCallback, useMemo } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES, RUNNER_IDS } from "../../types/messages";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useIsMobile, useMediaQuery } from "@hooks/useMediaQuery";
import { WebviewLog } from "@utils/logger";
import { WorkflowControls } from "../workflow/WorkflowControls";
import { WorkflowStatus } from "../workflow/WorkflowStatus";
import { SaveWorkflowDialog } from "../workflow/SaveWorkflowDialog";
import { TemplateModal } from "../workflow/TemplateModal";
import { FileBrowserModal } from "../workflow/FileBrowserModal";
import { UndoRedoControl } from "../shared/UndoRedoControl";
import { NavHistoryControls } from "../shared/NavHistoryControls";
import { HEADER_BUTTON_SIZES } from "../../constants";
import {
  getWorkflowExecutionControls,
  type WorkflowExecutionControlAction,
} from "@utils/status";

let saveRequestSequence = 0;

function nextSaveRequestId(): string {
  saveRequestSequence += 1;
  return `save-${Date.now()}-${saveRequestSequence}`;
}

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
 *   Wide (lg+):     ([WorkflowControls label][action] left) [spacer] [forward/back] [WorkflowStatus] [execution] [spacer] ([app nav] right)  ← one row
 *   Medium (sm–lg): ([WorkflowControls icon][action] left)  ([forward/back][WorkflowStatus][execution] center lane) ([app nav] right)  ← one row
 *   Narrow (< sm):  ([WorkflowControls icon] left) ([WorkflowStatus][execution] centered)                                         ← row 1
 *                   ([Steps]⟵edge [action] left)                    ([app nav] right [Workflow Properties]⟶edge)                 ← row 2
 *
 * Grid: mobile keeps [auto · minmax(0,1fr) · auto], then from sm up the header switches to
 * [auto · minmax(0,1fr) · auto]. At lg+ it expands to
 * [auto · minmax(0,1fr) · auto · minmax(0,500px) · auto · minmax(0,1fr) · auto].
 * The two flexible spacer tracks isolate the centered controls from the left and right groups, while the
 * dedicated nav/status/run tracks keep the status anchored to the page center and aligned with its dropdown.
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
  // WorkflowStatus is a heavy, stateful component (dropdown-open state, its own
  // ResizeObserver, document-level outside-click listener, and a GET_RECENT_WORKFLOWS
  // postMessage on mount). The header's three responsive tiers each have their own
  // wrapper with tier-specific layout, so historically each tier mounted its own
  // <WorkflowStatus>, hidden/shown purely via Tailwind classes — three simultaneous
  // live instances at all times, only one of which is ever visible. `layoutTier`
  // mirrors the header's own sm/lg Tailwind breakpoints via matchMedia so exactly one
  // tier's WorkflowStatus actually mounts; the other two wrappers render without it.
  const isWideLayout = useMediaQuery("(min-width: 1024px)");
  const isMediumLayout = !isMobile && !isWideLayout;
  const btnSize = isMobile
    ? HEADER_BUTTON_SIZES.touch
    : HEADER_BUTTON_SIZES.default;
  const openWorkspaceViewer = useWorkspaceViewerStore((s) => s.open);
  const { fileName, executionState } = useWorkflowStore();
  const hasPrompts = useWorkflowStore((s) => s.steps.length > 0);
  const {
    loadedWorkflows,
    activeWorkflowId,
    displayedViewAddress,
    executionRunRef,
    runSummaries,
    displayedDefinitionRevision,
    displayedDescriptorRevision,
    pendingRewind,
    newWorkflowModalOpen,
    closeNewWorkflowModal,
    mobileStepsOpen,
    mobileWorkflowPropsOpen,
    globalSettingsOpen,
    isHistorySearchOpen,
    toggleGlobalSettings,
    toggleHistorySearch,
  } = useUiStore();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy ===
    RUNNER_IDS.CLI;

  const hasFile = fileName !== null;
  const executionRunSummary = executionRunRef
    ? runSummaries.find((summary) => summary.runRef === executionRunRef)
    : undefined;
  const executionRunAddress = useMemo(
    () =>
      executionRunRef && displayedViewAddress
        ? {
            workflowKey: displayedViewAddress.workflowKey,
            kind: "run" as const,
            runRef: executionRunRef as never,
          }
        : null,
    [displayedViewAddress, executionRunRef]
  );
  const { isRunning, isPausing, isPaused, isCancelling, slot1, slot2, slot3 } =
    getWorkflowExecutionControls({
      viewedExecutionState: executionState,
      viewedKind: displayedViewAddress?.kind ?? null,
      hasFile,
      pendingRewind: pendingRewind !== null,
      executionRunState: executionRunSummary?.executionState,
      executionRunLabel: executionRunSummary
        ? `run ${executionRunSummary.runId}`
        : executionRunRef
          ? "the executing run"
          : null,
    });

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
    if (!canSave || !displayedViewAddress) return;
    vscode.postMessage({
      type: MESSAGE_TYPES.SAVE_WORKFLOW_REQUEST,
      requestId: nextSaveRequestId(),
      address: displayedViewAddress,
    });
  }, [vscode, canSave, displayedViewAddress]);

  // Handlers
  const postViewedRunAction = useCallback(
    (type: string) => {
      if (
        displayedViewAddress?.kind !== "run" ||
        displayedDefinitionRevision === null ||
        displayedDescriptorRevision === null
      ) {
        return;
      }
      vscode.postMessage({
        type,
        address: displayedViewAddress,
        expectedDefinitionRevision: displayedDefinitionRevision,
        expectedDescriptorRevision: displayedDescriptorRevision,
      });
    },
    [
      displayedDefinitionRevision,
      displayedDescriptorRevision,
      displayedViewAddress,
      vscode,
    ]
  );

  const handleSlotAction = useCallback(
    (action: WorkflowExecutionControlAction) => {
      if (action === "run-draft") {
        if (
          displayedViewAddress?.kind === "draft" &&
          displayedDefinitionRevision !== null &&
          displayedDescriptorRevision !== null
        ) {
          vscode.postMessage({
            type: MESSAGE_TYPES.EXECUTE_DRAFT,
            address: displayedViewAddress,
            expectedDefinitionRevision: displayedDefinitionRevision,
            expectedDescriptorRevision: displayedDescriptorRevision,
          });
        }
      } else if (action === "rerun") {
        postViewedRunAction(MESSAGE_TYPES.SEED_NEW_RUN);
      } else if (action === "continue") {
        postViewedRunAction(MESSAGE_TYPES.CONTINUE_RUN);
      } else if (action === "resume") {
        if (executionRunAddress) {
          vscode.postMessage({
            type: MESSAGE_TYPES.RESUME_RUN,
            address: executionRunAddress,
          });
        } else {
          postViewedRunAction(MESSAGE_TYPES.CONTINUE_RUN);
        }
      } else if (executionRunAddress) {
        const type =
          action === "pause"
            ? MESSAGE_TYPES.PAUSE_RUN
            : action === "cancel-pause"
              ? MESSAGE_TYPES.CANCEL_PAUSE_RUN
              : action === "stop"
                ? MESSAGE_TYPES.STOP_RUN
                : null;
        if (type) vscode.postMessage({ type, address: executionRunAddress });
      }
    },
    [
      displayedDefinitionRevision,
      displayedDescriptorRevision,
      displayedViewAddress,
      executionRunAddress,
      postViewedRunAction,
      vscode,
    ]
  );

  const handleStartNewRunInstead = useCallback(() => {
    postViewedRunAction(MESSAGE_TYPES.START_NEW_RUN_INSTEAD);
  }, [postViewedRunAction]);

  const handleDiscardContinuation = useCallback(() => {
    postViewedRunAction(MESSAGE_TYPES.DISCARD_CONTINUATION);
  }, [postViewedRunAction]);

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
        isCancelling,
        ...details,
      });
    },
    [executionState, isCancelling, isPaused, isRunning]
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

  // Below xs (380px) the row-1 grid has no room for greyed-out affordances, so
  // a disabled execution slot is hidden outright rather than shown at
  // opacity-50 — and a divider only earns its pixel when both of the slots it
  // separates are actually visible.
  const slot1Visible = slot1.enabled && !isCLIManaged;
  const slot2Visible = slot2.enabled && !isCLIManaged;
  const slot3Visible = slot3.enabled || isCLIManaged;
  const HIDDEN_UNTIL_XS = "hidden xs:flex";
  const dividerClass = (bothVisible: boolean) =>
    `fp-button-group-divider${bothVisible ? "" : " hidden xs:block"}`;

  const runControls = (
    <div className="header-run-controls flex items-center flex-shrink-0">
      <div
        className={`fp-button-group ${btnSize.groupContainer}`}
        role="group"
        aria-label="Workflow execution controls"
      >
        <button
          className={`control-button h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
            slot1.emphasized ? "font-bold" : ""
          } ${
            slot1Visible
              ? "flex bg-btn-bg text-btn-fg hover:bg-btn-hover"
              : `${HIDDEN_UNTIL_XS} bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed`
          }`}
          onClick={() => handleSlotAction(slot1.action)}
          disabled={!slot1.enabled || isCLIManaged}
          title={
            isCLIManaged ? "Workflow is running via ctrlyoke CLI" : slot1.title
          }
          aria-label={slot1.label}
        >
          <i className={`codicon ${slot1.icon} ${btnSize.icon}`} />
        </button>

        <div className={dividerClass(slot1Visible && slot2Visible)} />

        <button
          className={`control-button h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
            slot2Visible
              ? "flex bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              : `${HIDDEN_UNTIL_XS} bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed`
          }`}
          onClick={() => handleSlotAction(slot2.action)}
          disabled={!slot2.enabled || isCLIManaged}
          title={
            isCLIManaged ? "Workflow is running via ctrlyoke CLI" : slot2.title
          }
          aria-label={slot2.label}
        >
          <i
            className={`codicon ${slot2.icon} ${isPausing ? "animate-pulse-cancelling" : ""} ${btnSize.icon}`}
          />
        </button>

        <div className={dividerClass(slot2Visible && slot3Visible)} />

        <button
          className={`control-button h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
            slot3Visible
              ? "flex bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              : `${HIDDEN_UNTIL_XS} bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed`
          }`}
          onClick={
            isCLIManaged
              ? handleStopCliRun
              : () => handleSlotAction(slot3.action)
          }
          disabled={!slot3.enabled && !isCLIManaged}
          title={isCLIManaged ? "Stop CLI run" : slot3.title}
          aria-label={slot3.label}
        >
          <i className={`codicon ${slot3.icon} ${btnSize.icon}`} />
        </button>
      </div>
    </div>
  );

  return (
    <>
      <header className="header select-none [-webkit-touch-callout:none] grid grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,1fr)_auto] lg:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,500px)_auto_minmax(0,1fr)_auto] gap-x-1 gap-y-1.5 items-center sm:px-3 py-1.5 border-b-2 border-panel-border bg-sidebar-bg flex-shrink-0 overflow-visible">
        {/* Left Section: Workflow Controls — always top-left (col 1 / row 1) at every tier so the
            workflow picker anchors the corner. From sm up the action controls sit inline here; on
            narrow mobile they move to the combined row-2 group. */}
        <div className="header-left col-start-1 row-start-1 justify-self-start min-w-0 flex items-center gap-1 sm:gap-2 pl-1 sm:pl-0">
          <WorkflowControls compactUntilLg />
          {!isMobile && actionControls}
        </div>

        {/* Row-2 (mobile only): Steps pull | combined controls | Workflow Properties pull.
            Spans all 3 outer grid columns and uses its own 1fr·auto·1fr internal grid so the center
            group stays at the true screen midpoint regardless of what the outer auto columns hold. */}
        <div className="col-start-1 col-end-4 row-start-2 sm:hidden grid grid-cols-[1fr_auto_1fr] items-center">
          {/* Left (1fr): Steps drawer pull — flat left edge to screen, rounded toward content */}
          <div className="flex items-center">
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
          </div>

          {/* Center (auto): All controls in one group — Save, Undo/Redo, Search, Explorer, Settings */}
          <div
            className={`fp-button-group ${btnSize.groupContainer}`}
            role="group"
            aria-label="Workflow controls"
          >
            {/* Save */}
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
            <div className="fp-button-group-divider" />
            {/* Search */}
            <button
              className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
                isHistorySearchOpen ? "fp-contrast-active " : ""
              }${
                isHistorySearchOpen
                  ? "bg-btn-bg text-btn-fg hover:bg-btn-hover"
                  : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              }`}
              onClick={toggleHistorySearch}
              title="Search History (Ctrl+Shift+F)"
              aria-label="Search history"
              aria-pressed={isHistorySearchOpen}
            >
              <i className={`codicon codicon-search ${btnSize.icon}`} />
            </button>
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
            {/* Settings */}
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

          {/* Right (1fr): Workflow Properties drawer pull — rounded toward content, flat right edge to screen */}
          <div className="flex items-center justify-end">
            <button
              className={`control-button flex items-center justify-center gap-0.5 pl-2 pr-3.5 ${btnSize.mobileToggleButton} rounded-l-button border-y border-l border-btn-border transition-colors ${
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
          </div>
        </div>

        {/* Save Workflow Dialog — rendered here for co-location with SaveWorkflowButton */}
        <SaveWorkflowDialog />

        {/* Template Modal — controlled by uiStore.newWorkflowModalOpen */}
        <TemplateModal
          isOpen={newWorkflowModalOpen}
          onClose={closeNewWorkflowModal}
        />

        {/* File Browser Modal — controlled by uiStore.fileBrowserState; one
            canonical instance shared by every standalone-mode caller. */}
        <FileBrowserModal />

        {/* Mobile status row: forward/back + WorkflowStatus. Hidden from sm up, where both controls
            move into the shared center lane so they can negotiate width together. */}
        <div className="header-status col-start-2 row-start-1 justify-self-stretch w-full flex items-center justify-center min-w-0 gap-0 px-1 sm:hidden">
          {!isMobile && <NavHistoryControls className="flex-shrink-0" />}
          {isMobile && <WorkflowStatus className="flex-1 min-w-0" />}
        </div>

        {/* Desktop center lane: medium keeps a shared flex row, while lg+ promotes the centered
            region back into dedicated tracks so WorkflowStatus stays perfectly page-centered. */}
        <div className="hidden sm:flex sm:col-start-2 sm:row-start-1 lg:hidden min-w-0 items-center justify-center gap-0">
          <NavHistoryControls className="hidden md:flex flex-shrink-0" />
          {isMediumLayout && (
            <WorkflowStatus className="flex-1 min-w-[200px] max-w-[500px] mr-1" />
          )}
          {runControls}
        </div>

        <div className="hidden lg:flex lg:col-start-3 lg:row-start-1 items-center justify-end min-w-0 mr-1">
          <NavHistoryControls className="hidden md:flex flex-shrink-0" />
        </div>

        <div className="hidden lg:flex lg:col-start-4 lg:row-start-1 items-center justify-center min-w-0">
          {isWideLayout && (
            <WorkflowStatus className="w-full min-w-0 max-w-[500px]" />
          )}
        </div>

        <div className="hidden lg:flex lg:col-start-5 lg:row-start-1 items-center justify-start min-w-0 ml-1">
          {isWideLayout && runControls}
        </div>

        {/* Mobile run controls stay in their own grid column to keep the narrow row-1 layout compact. */}
        <div className="col-start-3 row-start-1 justify-self-center flex items-center sm:hidden pr-1">
          {isMobile && runControls}
        </div>

        {/* Right Section: App navigation — Search / Workspace Explorer / Settings.
            Desktop only (sm+); on mobile these buttons live in the row-2 combined center group. */}
        <div className="header-nav hidden sm:flex sm:col-start-3 sm:col-end-4 sm:row-start-1 lg:col-start-7 lg:col-end-8 min-w-0 items-center justify-end">
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
              onClick={toggleHistorySearch}
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
        </div>
      </header>
      {isPausing && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-[var(--status-warning)] text-[var(--btn-fg)] border-b border-btn-border">
          <i className="codicon codicon-debug-pause animate-pulse-cancelling" />
          <span>Workflow will pause after the current step completes</span>
          <button
            className="ml-auto text-xs underline opacity-80 hover:opacity-100"
            onClick={() => handleSlotAction(slot2.action)}
            aria-label="Cancel pause"
          >
            Cancel
          </button>
        </div>
      )}
      {pendingRewind && displayedViewAddress?.kind === "run" && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs bg-status-warning text-btn-fg border-b border-btn-border"
          role="status"
          aria-label={`Continuing run from step ${pendingRewind.fromStepIndex + 1}`}
        >
          <i className="codicon codicon-debug-continue" aria-hidden="true" />
          <span>
            Continuing run from step {pendingRewind.fromStepIndex + 1}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <button
              className="text-xs underline opacity-90 hover:opacity-100 focus-visible:outline focus-visible:outline-1"
              onClick={handleDiscardContinuation}
            >
              Discard Continuation
            </button>
            <button
              className="text-xs underline opacity-90 hover:opacity-100 focus-visible:outline focus-visible:outline-1"
              onClick={handleStartNewRunInstead}
            >
              Start new run instead
            </button>
          </div>
        </div>
      )}
    </>
  );
};
