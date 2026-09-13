import React, { useCallback, useMemo } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import {
  EXECUTION_STATES,
  MESSAGE_TYPES,
  RUNNER_IDS,
} from "../../types/messages";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useIsMobile, useMediaQuery } from "@hooks/useMediaQuery";
import { useLongPress } from "@hooks/useLongPress";
import { useIsViewingDeletedWorkflow } from "@hooks/useIsViewingDeletedWorkflow";
import { useIsSystemGeneratedWorkflow } from "@hooks/useIsSystemGeneratedWorkflow";
import { sendMessage } from "@hooks/useMessageHandler";
import { WebviewLog } from "@utils/logger";
import { getExecutionPreviewEditorSnapshot } from "@utils/executionPreview";
import { getExternalRunnerLabel } from "@utils/externalRunner";
import { formatShortcut } from "@utils/platform";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { WorkflowControls } from "../workflow/WorkflowControls";
import { WorkflowStatus } from "../workflow/WorkflowStatus";
import { HeaderStatusBanner } from "./HeaderStatusBanner";
import { SaveWorkflowDialog } from "../workflow/SaveWorkflowDialog";
import { DuplicateWorkflowDialog } from "../workflow/DuplicateWorkflowDialog";
import { TemplateModal } from "../workflow/TemplateModal";
import { FileBrowserModal } from "../workflow/FileBrowserModal";
import { SuffixEditConfirmModal } from "../shared/SuffixEditConfirmModal";
import { UndoRedoControl } from "../shared/UndoRedoControl";
import { NavHistoryControls } from "../shared/NavHistoryControls";
import { DryRunModal } from "../shared/DryRunModal";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "../shared/StepContextMenu";
import { HEADER_BUTTON_SIZES } from "../../constants";
import {
  getWorkflowExecutionControls,
  type WorkflowExecutionControlAction,
} from "@utils/status";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import {
  PREVIEW_SCOPES,
  WORKFLOW_EXECUTION_CONTROL_ACTIONS,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import { Icon } from "../shared/Icon";

let saveRequestSequence = 0;

function nextSaveRequestId(): string {
  saveRequestSequence += 1;
  return `save-${Date.now()}-${saveRequestSequence}`;
}

function DryRunButton({
  btnSize,
  onClick,
  disabled,
}: {
  btnSize: (typeof HEADER_BUTTON_SIZES)[keyof typeof HEADER_BUTTON_SIZES];
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
        disabled
          ? "bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
          : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
      }`}
      onClick={onClick}
      disabled={disabled}
      title="Dry Run"
      aria-label="Dry Run"
    >
      <Icon name="telescope" className={`${btnSize.icon}`} />
    </button>
  );
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
  const hasSteps = useWorkflowStore((s) => s.steps.length > 0);
  const hasFinalStep = useWorkflowStore((s) => s.finalStep !== null);
  // Selectors must return primitives here: a fresh array/object identity per
  // call re-renders on every unrelated store write. `_runtime` is the persisted
  // per-step record — present from the moment a step starts, and stripped
  // entirely when a run is seeded — so it answers "has anything executed in
  // this run" without depending on the view-only `status` field.
  const currentStep = useWorkflowStore((s) => s.currentStep);
  const hasStepProgress = useWorkflowStore(
    (s) =>
      s.finalStepStatus !== null ||
      s.steps.some((step) => step._runtime !== undefined)
  );
  const {
    loadedWorkflows,
    activeWorkflowId,
    displayedViewAddress,
    executionRunRef,
    runSummaries,
    displayedDefinitionRevision,
    displayedDescriptorRevision,
    pendingRewind,
    viewingDeletedWorkflow,
    newWorkflowModalOpen,
    closeNewWorkflowModal,
    mobileStepsOpen,
    mobileWorkflowPropsOpen,
    globalSettingsOpen,
    isHistorySearchOpen,
    toggleGlobalSettings,
    toggleHistorySearch,
    suffixEditConfirmation,
    setSuffixEditConfirmation,
  } = useUiStore();
  const workflowExternalRootsApprovalRequired = useSettingsStore(
    (state) => state.workflowExternalRootsApprovalRequired
  );

  const activeWorkflow = loadedWorkflows.find(
    (workflow) => workflow.id === activeWorkflowId
  );

  // Any non-local runner owns the live files, so the dashboard is read-only.
  const externalOwner = activeWorkflow?.externalOwner;
  const isExternallyManaged = externalOwner != null;
  const externalManagementLabel = getExternalRunnerLabel(externalOwner);
  // The lineage on screen was deleted (from history) while being viewed —
  // its backing files are gone, so every workflow-mutating control is locked
  // except the prompt editor (see EditorSection — its draft is intentionally
  // workflow-agnostic).
  const isViewingDeletedWorkflow = useIsViewingDeletedWorkflow();
  // The lineage on screen is an internal system lineage (e.g. commit message
  // generation) — its harness/model/execution settings are overridden by its
  // owning feature on every real run regardless of what's edited here, and
  // re-running it from the dashboard would bypass those overrides entirely,
  // so it gets the same lockdown as a deleted workflow.
  const isSystemGeneratedWorkflow = useIsSystemGeneratedWorkflow();
  const isLineageReadOnly =
    isViewingDeletedWorkflow || isSystemGeneratedWorkflow;

  const hasFile = fileName !== null;
  const executionRunSummary = executionRunRef
    ? runSummaries.find((summary) => summary.runRef === executionRunRef)
    : undefined;
  // `runSummaries` is a snapshot frozen at the last RUN_VIEW_LOADED, so its
  // executionState goes stale the moment the executing run transitions
  // (running → pausing → paused) — a run seeded and started in one gesture
  // leaves that snapshot reading "idle" for its whole lifetime. loadedWorkflows
  // mirrors every *active* workflow and is kept current by WORKFLOW_ADDED /
  // WORKFLOW_SUMMARY_UPDATED / WORKFLOW_DISMISSED, so it is the live source for
  // the executing run's state; the snapshot is only the fallback.
  const liveExecutionRunState = loadedWorkflows.find((workflow) =>
    executionRunRef
      ? workflow.runRef === executionRunRef
      : workflow.id === activeWorkflowId
  )?.executionState;
  const executionRunAddress = useMemo<Extract<
    WorkflowViewAddress,
    { kind: "run" }
  > | null>(() => {
    // WORKFLOW_ADDED is the first authoritative runtime identity update when a
    // completed run is reopened by appending another prompt. At that instant
    // executionRunRef may still be null because the previous terminal state
    // cleared it, but the visible Pause/Stop controls are already active. Use
    // the active workflow summary first so those controls never become no-ops.
    if (activeWorkflow?.workflowKey && activeWorkflow.runRef) {
      return {
        workflowKey: activeWorkflow.workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: activeWorkflow.runRef,
      };
    }
    if (!executionRunRef || !displayedViewAddress) return null;
    return {
      workflowKey: displayedViewAddress.workflowKey,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
      runRef: executionRunRef as Extract<
        WorkflowViewAddress,
        { kind: "run" }
      >["runRef"],
    };
  }, [activeWorkflow, displayedViewAddress, executionRunRef]);
  const { isRunning, isPausing, isPaused, isCancelling, slot1, slot2, slot3 } =
    getWorkflowExecutionControls({
      viewedExecutionState: executionState,
      viewedKind: displayedViewAddress?.kind ?? null,
      hasFile,
      // A workflow can begin with its final step, which may append its first
      // queue steps. Keep the execution gate open for that final-step-only
      // workflow shape while retaining `hasSteps` for save affordances.
      hasSteps: hasSteps || hasFinalStep,
      pendingRewind: pendingRewind !== null,
      executionRunState:
        liveExecutionRunState ?? executionRunSummary?.executionState,
      executionRunLabel: executionRunSummary
        ? `run ${executionRunSummary.runId}`
        : executionRunRef
          ? "the executing run"
          : null,
      // Seeding a run and executing it are separate operations — `Set start
      // position` on the first step seeds a run and leaves it idle — so a run
      // can legitimately sit here having executed nothing at all. Offer Run for
      // it rather than Re-run, which would fork yet another empty run.
      viewedRunUnstarted:
        displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
        executionState === EXECUTION_STATES.IDLE &&
        currentStep === 0 &&
        !hasStepProgress,
    });
  const dryRunScope = useExecutionPreviewStore((state) => state.scope);

  const handleStopExternallyManagedRun = useCallback(() => {
    if (!activeWorkflowId) return;
    sendMessage(
      externalOwner?.runner === RUNNER_IDS.VSCODE
        ? MESSAGE_TYPES.STOP_VSCODE_RUN
        : MESSAGE_TYPES.STOP_CLI_RUN,
      { workflowId: activeWorkflowId }
    );
  }, [activeWorkflowId, externalOwner]);

  const dryRunDisabled = !displayedViewAddress || isLineageReadOnly;
  const canSave = hasFile && !isLineageReadOnly;
  const saveTitle = isViewingDeletedWorkflow
    ? "This workflow has been deleted"
    : isSystemGeneratedWorkflow
      ? "Managed automatically by commit message generation"
      : hasFile
        ? "Save workflow to file"
        : "Load a workflow to save";

  const handleSave = useCallback(() => {
    if (!canSave || !displayedViewAddress) return;
    vscode.postMessage({
      type: MESSAGE_TYPES.SAVE_WORKFLOW_REQUEST,
      requestId: nextSaveRequestId(),
      address: displayedViewAddress,
    });
  }, [vscode, canSave, displayedViewAddress]);

  const openDryRunWorkflow = useCallback(() => {
    useExecutionPreviewStore
      .getState()
      .open(
        { kind: PREVIEW_SCOPES.WORKFLOW },
        getExecutionPreviewEditorSnapshot()
      );
  }, []);

  const [runContextMenu, setRunContextMenu] =
    React.useState<StepContextMenuState | null>(null);
  const openRunDryRunMenu = useCallback(
    (x: number, y: number) => {
      setRunContextMenu({
        x,
        y,
        items: [
          {
            label: "Dry Run",
            icon: "codicon-telescope",
            disabled: false,
            onClick: openDryRunWorkflow,
          },
        ],
      });
    },
    [openDryRunWorkflow]
  );
  const runSlotLongPressHandlers = useLongPress(openRunDryRunMenu);

  // Handlers
  const postViewedRunAction = useCallback(
    (type: string) => {
      if (
        displayedViewAddress?.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN ||
        displayedDefinitionRevision === null ||
        displayedDescriptorRevision === null
      ) {
        return;
      }
      sendMessage(type, {
        address: displayedViewAddress,
        expectedDefinitionRevision: displayedDefinitionRevision,
        expectedDescriptorRevision: displayedDescriptorRevision,
      });
    },
    [
      displayedDefinitionRevision,
      displayedDescriptorRevision,
      displayedViewAddress,
    ]
  );

  const handleSlotAction = useCallback(
    (action: WorkflowExecutionControlAction) => {
      if (action === "run-draft") {
        if (
          displayedViewAddress?.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT &&
          displayedDefinitionRevision !== null &&
          displayedDescriptorRevision !== null
        ) {
          sendMessage(MESSAGE_TYPES.EXECUTE_DRAFT, {
            address: displayedViewAddress,
            expectedDefinitionRevision: displayedDefinitionRevision,
            expectedDescriptorRevision: displayedDescriptorRevision,
          });
        }
      } else if (action === "rerun") {
        postViewedRunAction(MESSAGE_TYPES.SEED_NEW_RUN);
      } else if (action === "continue" || action === "start-run") {
        // Starting a never-executed run *is* a continuation from its own step 0:
        // the run directory, working file, and timeline already exist, so the
        // backend only has to bind and execute what is on disk.
        postViewedRunAction(MESSAGE_TYPES.CONTINUE_RUN);
      } else if (action === "restart") {
        postViewedRunAction(MESSAGE_TYPES.START_NEW_RUN_INSTEAD);
      } else if (action === "resume") {
        if (executionRunAddress) {
          sendMessage(MESSAGE_TYPES.RESUME_RUN, {
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
              : action === WORKFLOW_EXECUTION_CONTROL_ACTIONS.STOP
                ? MESSAGE_TYPES.STOP_RUN
                : null;
        if (type) sendMessage(type, { address: executionRunAddress });
      }
    },
    [
      displayedDefinitionRevision,
      displayedDescriptorRevision,
      displayedViewAddress,
      executionRunAddress,
      postViewedRunAction,
    ]
  );

  const handleDiscardContinuation = useCallback(() => {
    postViewedRunAction(MESSAGE_TYPES.DISCARD_CONTINUATION);
  }, [postViewedRunAction]);

  // Same action as the WorkflowControls "New" button — drops the cached view
  // of the deleted lineage and starts a blank workflow. No "undo" here:
  // REMOVE_WORKFLOW_HISTORY already hard-deleted the backing files by the
  // time this banner appears.
  const handleCloseDeletedWorkflow = useCallback(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
  }, [vscode]);

  const handleCancelSuffixEditConfirmation = useCallback(() => {
    setSuffixEditConfirmation(null);
  }, [setSuffixEditConfirmation]);

  const handleConfirmSuffixEditDiscard = useCallback(() => {
    if (!suffixEditConfirmation) return;
    const {
      action,
      address,
      expectedDefinitionRevision,
      expectedDescriptorRevision,
    } = suffixEditConfirmation;
    sendMessage(
      action === MESSAGE_TYPES.START_NEW_RUN_INSTEAD
        ? MESSAGE_TYPES.START_NEW_RUN_INSTEAD
        : MESSAGE_TYPES.DISCARD_CONTINUATION,
      {
        address,
        expectedDefinitionRevision,
        expectedDescriptorRevision,
        confirmEditedSuffix: true,
      }
    );
    setSuffixEditConfirmation(null);
  }, [suffixEditConfirmation, setSuffixEditConfirmation]);

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
      className={`cy-button-group ${btnSize.groupContainer}`}
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
        title={saveTitle}
        aria-label="Save workflow"
      >
        <Icon name="save" className={`${btnSize.icon}`} />
      </button>

      <div className="cy-button-group-divider" />

      <DryRunButton
        btnSize={btnSize}
        onClick={openDryRunWorkflow}
        disabled={dryRunDisabled}
      />

      <div className="cy-button-group-divider" />

      {/* Undo / Redo / History */}
      <UndoRedoControl
        isRunning={isRunning}
        isPaused={isPaused}
        disabled={isLineageReadOnly}
        embedded
        showHistoryChevronOnDesktopOnly="lg"
        onAction={handleUndoRedoAction}
      />
    </div>
  );

  // Below xs (380px), show only actionable execution slots. If none are
  // actionable, retain the disabled Run slot so the primary affordance never
  // disappears completely. From xs upward all three fixed slots remain visible.
  const slot1Enabled =
    slot1.enabled &&
    !isExternallyManaged &&
    !isLineageReadOnly &&
    !workflowExternalRootsApprovalRequired;
  const slot2Enabled =
    slot2.enabled && !isExternallyManaged && !isLineageReadOnly;
  const slot3Enabled =
    (slot3.enabled || isExternallyManaged) && !isLineageReadOnly;
  const restartOnlyOnNarrow =
    executionState === EXECUTION_STATES.STOPPED &&
    !isRunning &&
    !isPausing &&
    !isPaused &&
    !isCancelling;
  const slot2NarrowVisible = slot2Enabled && !restartOnlyOnNarrow;
  const slot1NarrowVisible =
    slot1Enabled || (!slot2NarrowVisible && !slot3Enabled);
  const HIDDEN_UNTIL_XS = "hidden xs:flex";
  const dividerClass = (bothVisible: boolean) =>
    `cy-button-group-divider${bothVisible ? "" : " hidden xs:block"}`;

  const runControls = (
    <div className="header-run-controls flex items-center flex-shrink-0">
      <div
        className={`cy-button-group ${btnSize.groupContainer}`}
        role="group"
        aria-label="Workflow execution controls"
      >
        <button
          className={`control-button h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
            slot1.emphasized ? "font-bold" : ""
          } ${
            slot1Enabled
              ? "flex bg-btn-bg text-btn-fg hover:bg-btn-hover"
              : `${slot1NarrowVisible ? "flex" : HIDDEN_UNTIL_XS} bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed`
          }`}
          onClick={() => handleSlotAction(slot1.action)}
          onContextMenu={(event) => {
            event.preventDefault();
            openRunDryRunMenu(event.clientX, event.clientY);
          }}
          {...runSlotLongPressHandlers}
          disabled={
            !slot1.enabled ||
            isExternallyManaged ||
            isLineageReadOnly ||
            workflowExternalRootsApprovalRequired
          }
          title={
            externalManagementLabel
              ? `Workflow is running via ${externalManagementLabel}`
              : isViewingDeletedWorkflow
                ? "This workflow has been deleted"
                : isSystemGeneratedWorkflow
                  ? "Managed automatically by commit message generation"
                  : workflowExternalRootsApprovalRequired
                    ? "Approve requested external file roots before running"
                    : slot1.title
          }
          aria-label={slot1.label}
        >
          <Icon name={slot1.icon} className={btnSize.icon} />
        </button>

        <div
          className={dividerClass(slot1NarrowVisible && slot2NarrowVisible)}
        />

        <button
          className={`control-button h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
            slot2.emphasized ? "font-bold" : ""
          } ${
            slot2Enabled
              ? `${slot2NarrowVisible ? "flex" : HIDDEN_UNTIL_XS} bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover`
              : `${HIDDEN_UNTIL_XS} bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed`
          }`}
          onClick={() => handleSlotAction(slot2.action)}
          disabled={!slot2.enabled || isExternallyManaged || isLineageReadOnly}
          title={
            externalManagementLabel
              ? `Workflow is running via ${externalManagementLabel}`
              : isViewingDeletedWorkflow
                ? "This workflow has been deleted"
                : isSystemGeneratedWorkflow
                  ? "Managed automatically by commit message generation"
                  : slot2.title
          }
          aria-label={slot2.label}
        >
          <Icon
            name={slot2.icon}
            className={`${isPausing ? "animate-pulse-cancelling" : ""} ${btnSize.icon}`}
          />
        </button>

        <div className={dividerClass(slot2NarrowVisible && slot3Enabled)} />

        <button
          className={`control-button h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
            slot3Enabled
              ? "flex bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              : `${HIDDEN_UNTIL_XS} bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed`
          }`}
          onClick={
            isExternallyManaged
              ? handleStopExternallyManagedRun
              : () => handleSlotAction(slot3.action)
          }
          disabled={
            (!slot3.enabled && !isExternallyManaged) || isLineageReadOnly
          }
          title={
            isExternallyManaged
              ? externalOwner?.runner === RUNNER_IDS.CLI
                ? "Stop CLI run"
                : "Stop run in another ctrlyoke window"
              : isViewingDeletedWorkflow
                ? "This workflow has been deleted"
                : isSystemGeneratedWorkflow
                  ? "Managed automatically by commit message generation"
                  : slot3.title
          }
          aria-label={slot3.label}
        >
          <Icon name={slot3.icon} className={btnSize.icon} />
        </button>
      </div>
      {runContextMenu && (
        <StepContextMenu
          {...runContextMenu}
          onClose={() => setRunContextMenu(null)}
        />
      )}
    </div>
  );

  return (
    <>
      <header className="header cy-no-select grid grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,1fr)_auto] lg:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,500px)_auto_minmax(0,1fr)_auto] gap-x-1 gap-y-1.5 items-center sm:px-3 py-1.5 border-b-2 border-panel-border bg-sidebar-bg flex-shrink-0 overflow-visible">
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
                mobileStepsOpen ? "cy-contrast-active " : ""
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
              <Icon name="list-ordered" className={`${btnSize.icon}`} />
            </button>
          </div>

          {/* Center (auto): All controls in one group — Save, Undo/Redo, Search, Explorer, Settings */}
          <div
            className={`cy-button-group ${btnSize.groupContainer}`}
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
              title={saveTitle}
              aria-label="Save workflow"
            >
              <Icon name="save" className={`${btnSize.icon}`} />
            </button>
            <div className="cy-button-group-divider" />
            <DryRunButton
              btnSize={btnSize}
              onClick={openDryRunWorkflow}
              disabled={dryRunDisabled}
            />
            <div className="cy-button-group-divider" />
            {/* Undo / Redo / History */}
            <UndoRedoControl
              isRunning={isRunning}
              isPaused={isPaused}
              disabled={isLineageReadOnly}
              embedded
              showHistoryChevronOnDesktopOnly="lg"
              onAction={handleUndoRedoAction}
            />
            <div className="cy-button-group-divider" />
            {/* Search */}
            <button
              className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
                isHistorySearchOpen ? "cy-contrast-active " : ""
              }${
                isHistorySearchOpen
                  ? "bg-btn-bg text-btn-fg hover:bg-btn-hover"
                  : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              }`}
              onClick={toggleHistorySearch}
              title={`Search History (${formatShortcut("Ctrl", "Shift", "F")})`}
              aria-label="Search history"
              aria-pressed={isHistorySearchOpen}
            >
              <Icon name="search" className={`${btnSize.icon}`} />
            </button>
            {isStandalone && (
              <>
                <div className="cy-button-group-divider" />
                <button
                  className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover`}
                  onClick={openWorkspaceViewer}
                  title="Explore files and changes"
                  aria-label="Explore files and changes"
                >
                  <Icon name="files" className={`${btnSize.icon}`} />
                </button>
              </>
            )}
            <div className="cy-button-group-divider" />
            {/* Settings */}
            <button
              className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
                globalSettingsOpen ? "cy-contrast-active " : ""
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
              <Icon name="settings-gear" className={`${btnSize.icon}`} />
            </button>
          </div>

          {/* Right (1fr): Workflow Properties drawer pull — rounded toward content, flat right edge to screen */}
          <div className="flex items-center justify-end">
            <button
              className={`control-button flex items-center justify-center gap-0.5 pl-2 pr-3.5 ${btnSize.mobileToggleButton} rounded-l-button border-y border-l border-btn-border transition-colors ${
                mobileWorkflowPropsOpen ? "cy-contrast-active " : ""
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
              <Icon name="settings" className={`${btnSize.icon}`} />
            </button>
          </div>
        </div>

        {/* Save Workflow Dialog — rendered here for co-location with SaveWorkflowButton */}
        <SaveWorkflowDialog />
        <DuplicateWorkflowDialog />

        {/* Template Modal — controlled by uiStore.newWorkflowModalOpen */}
        <TemplateModal
          isOpen={newWorkflowModalOpen}
          onClose={closeNewWorkflowModal}
        />

        {/* File Browser Modal — controlled by uiStore.fileBrowserState; one
            canonical instance shared by every standalone-mode caller. */}
        <FileBrowserModal />

        {/* Suffix-edit discard confirmation — controlled by
            uiStore.suffixEditConfirmation, set when the extension reports that
            a discard-continuation/start-new-run-instead request hit unsaved
            edits to the rewound suffix. */}
        <SuffixEditConfirmModal
          isOpen={suffixEditConfirmation !== null}
          title={
            suffixEditConfirmation?.action ===
            MESSAGE_TYPES.START_NEW_RUN_INSTEAD
              ? "Start New Run Instead"
              : "Discard Continuation"
          }
          message={
            suffixEditConfirmation?.action ===
            MESSAGE_TYPES.START_NEW_RUN_INSTEAD
              ? "Discard continuation edits and start a new run? Your changes to the rewound suffix will be lost."
              : "Discard continuation edits? Your changes to the rewound suffix will be lost."
          }
          confirmLabel={
            suffixEditConfirmation?.action ===
            MESSAGE_TYPES.START_NEW_RUN_INSTEAD
              ? "Start New Run"
              : "Discard Continuation"
          }
          onConfirm={handleConfirmSuffixEditDiscard}
          onCancel={handleCancelSuffixEditConfirmation}
        />

        {dryRunScope && <DryRunModal scope={dryRunScope} />}

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
            className={`cy-button-group ${btnSize.groupContainer}`}
            role="group"
            aria-label="App navigation controls"
          >
            {/* Search */}
            <button
              className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
                isHistorySearchOpen ? "cy-contrast-active " : ""
              }${
                isHistorySearchOpen
                  ? "bg-btn-bg text-btn-fg hover:bg-btn-hover"
                  : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              }`}
              onClick={toggleHistorySearch}
              title={`Search History (${formatShortcut("Ctrl", "Shift", "F")})`}
              aria-label="Search history"
              aria-pressed={isHistorySearchOpen}
            >
              <Icon name="search" className={`${btnSize.icon}`} />
            </button>

            {/* Workspace Explorer — standalone (browser) mode only */}
            {isStandalone && (
              <>
                <div className="cy-button-group-divider" />
                <button
                  className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover`}
                  onClick={openWorkspaceViewer}
                  title="Explore files and changes"
                  aria-label="Explore files and changes"
                >
                  <Icon name="files" className={`${btnSize.icon}`} />
                </button>
              </>
            )}

            <div className="cy-button-group-divider" />

            {/* Settings button */}
            <button
              className={`control-button flex h-full self-stretch items-center justify-center ${btnSize.iconButton} rounded-none border-0 transition-colors ${
                globalSettingsOpen ? "cy-contrast-active " : ""
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
              <Icon name="settings-gear" className={`${btnSize.icon}`} />
            </button>
          </div>
        </div>
      </header>
      <HeaderStatusBanner
        isPausing={isPausing}
        handleCancelPause={() => handleSlotAction(slot2.action)}
        isViewingDeletedWorkflow={isViewingDeletedWorkflow}
        viewingDeletedWorkflow={viewingDeletedWorkflow}
        handleCloseDeletedWorkflow={handleCloseDeletedWorkflow}
        pendingRewind={pendingRewind}
        displayedViewAddress={displayedViewAddress}
        handleDiscardContinuation={handleDiscardContinuation}
      />
    </>
  );
};
