import { useCallback, useState } from "react";
import {
  ContextMenu,
  type ContextMenuState,
} from "@components/shared/ContextMenu";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  PARALLEL_DISPATCH_REFUSALS,
  QUEUE_POSITION,
  SUB_WORKFLOW_QUEUE_LABELS,
  USER_FEEDBACK_SEVERITY,
  WORKFLOW_DELETE_SCOPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
  type ExecutionState,
  type WorkflowDeleteScope,
} from "@root/types/DashboardConstants";
import { writeClipboardText } from "@utils/clipboard";
import { notifyUser } from "@utils/notifyUser";
import { openWorkflowDryRun } from "@utils/executionPreview";
import { generateId } from "@utils/string";
import { isWorkflowActive } from "@utils/status";
import { workflowViewAddressKey } from "@utils/viewAddress";
import { sendMessage } from "@messaging/sendMessage";
import { useIsViewingDeletedWorkflow } from "@hooks/useIsViewingDeletedWorkflow";
import { useIsSystemGeneratedWorkflow } from "@hooks/useIsSystemGeneratedWorkflow";
import { useSubWorkflowFilePicker } from "@hooks/useSubWorkflowFilePicker";
import { useSettingsStore } from "@store/settingsStore";
import { useTerminalStore } from "@store/terminalStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import type { WorkflowSchedule } from "@root/types/CtrlYokeTypes";
import { WORKFLOW_SCHEDULE_LABELS } from "@/constants";
import { upcomingScheduleRunLabel } from "@utils/workflowScheduleDisplay";

export interface WorkflowContextMenuTarget {
  address: WorkflowViewAddress;
  workflowName: string;
  /**
   * "lineage" — the whole workflow (list rows, header). Delete removes it and
   * all its history.
   * "run" — one addressed run inside a lineage (run-panel rows). Delete removes
   * only that run.
   */
  scope: WorkflowDeleteScope;
  /** Lineage-scoped on every surface, including run-panel rows. */
  isFavorite?: boolean;
  schedule?: WorkflowSchedule;
  scheduleNextRunAt?: number;
  scheduleLastMissedAt?: number;
  scheduleOnOtherHost?: boolean;
  /** Absent → Copy renders disabled. */
  runDirectory?: string;
  /** Executing right now — disables Delete and New Run. */
  isExecuting: boolean;
  /**
   * The addressed run was prepared but never executed. New Run then reopens it
   * rather than copying it (the backend decides either way; this only picks
   * the honest label).
   */
  isUnstarted?: boolean;
}

interface UseWorkflowContextMenuOptions {
  onDuplicate: (
    target: WorkflowContextMenuTarget,
    opener: HTMLElement | null
  ) => void;
  onToggleFavorite: (address: WorkflowViewAddress) => void;
  onDelete: (target: WorkflowContextMenuTarget) => void;
  onCloseDropdown: () => void;
  onEditSchedule: (
    target: WorkflowContextMenuTarget,
    opener: HTMLElement | null
  ) => void;
}

const copyRunDirectoryTitle =
  "Copies the path; in hosted browser mode, it is on the server's filesystem.";

const exitTerminalExplanation =
  "Sends the harness its exit keystroke (Ctrl+C) so the TUI quits, then ends the process. Sessions stay resumable, and a named worktree held only by an open terminal is released.";

/** Displayed-run states a workflow can be queued after (live or settled). */
const QUEUE_NEXT_STATES: readonly ExecutionState[] = [
  EXECUTION_STATES.RUNNING,
  EXECUTION_STATES.PAUSING,
  EXECUTION_STATES.PAUSED,
  EXECUTION_STATES.COMPLETED,
  EXECUTION_STATES.STOPPED,
  EXECUTION_STATES.ERROR,
];

function copyToClipboard(text: string, what: string): void {
  void writeClipboardText(text)
    .then(() => {
      notifyUser(`${what} copied to clipboard`, USER_FEEDBACK_SEVERITY.SUCCESS);
    })
    .catch(() => {
      notifyUser(
        `Failed to copy ${what.toLowerCase()}`,
        USER_FEEDBACK_SEVERITY.ERROR
      );
    });
}

export function useWorkflowContextMenu({
  onDuplicate,
  onToggleFavorite,
  onDelete,
  onCloseDropdown,
  onEditSchedule,
}: UseWorkflowContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const activeTerminalWorkflows = useTerminalStore(
    (state) => state.activeTerminalWorkflows
  );
  const displayedViewAddress = useUiStore(
    (state) => state.displayedViewAddress
  );
  const isViewingDeletedWorkflow = useIsViewingDeletedWorkflow();
  const isSystemGeneratedWorkflow = useIsSystemGeneratedWorkflow();
  const displayedExecutionState = useWorkflowStore(
    (state) => state.executionState
  );
  const finalStepPhase = useWorkflowStore((state) => state.finalStepPhase);
  const effectiveParallelGroupWidth = useSettingsStore(
    (state) => state.globalSettings.effectiveParallelGroupWidth
  );
  const loadedWorkflows = useUiStore((state) => state.loadedWorkflows);
  const { requestSubWorkflowFile, subWorkflowPickerModal } =
    useSubWorkflowFilePicker();

  const openContextMenu = useCallback(
    (
      x: number,
      y: number,
      target: WorkflowContextMenuTarget,
      opener: HTMLElement | null = null
    ) => {
      const hasRunDirectory = Boolean(target.runDirectory);
      const hasOpenTerminal = activeTerminalWorkflows.some(
        (ref) => ref.workflowKey === target.address.workflowKey
      );
      const exitTerminalDisabledTitle = target.isExecuting
        ? "This workflow is executing or paused — use Stop to end its step"
        : hasOpenTerminal
          ? undefined
          : "This workflow has no open terminal";
      const deleteLabel =
        target.scope === WORKFLOW_DELETE_SCOPES.LINEAGE
          ? "Delete Workflow"
          : "Delete Run";
      const isDraftRun =
        target.scope === WORKFLOW_DELETE_SCOPES.RUN &&
        target.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT;
      const deleteDisabledTitle = target.isExecuting
        ? `Cannot delete ${target.scope === WORKFLOW_DELETE_SCOPES.LINEAGE ? "a workflow" : "a run"} while it is executing`
        : isDraftRun
          ? "The draft cannot be deleted from the run panel"
          : undefined;
      // A never-run workflow's draft is already the unstarted next run, and
      // its header already offers Run — there is nothing to prepare.
      const runAddress =
        target.address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
          ? target.address
          : null;
      // A Dry Run previews this client's displayed workflow (with the unsaved
      // editor overlaid), so it is offered only on the row that addresses it.
      const isDisplayedTarget =
        displayedViewAddress !== null &&
        workflowViewAddressKey(displayedViewAddress) ===
          workflowViewAddressKey(target.address);
      const dryRunDisabledTitle = isViewingDeletedWorkflow
        ? "This workflow has been deleted"
        : isSystemGeneratedWorkflow
          ? "Managed automatically by commit message generation"
          : undefined;
      // Queuing a sub-workflow is offered only on the row that addresses the
      // displayed run: a settled run continues through the revision-checked
      // append-and-continue path, and the client holds revisions only for
      // the view it displays.
      const subWorkflowRunAddress =
        isDisplayedTarget && runAddress && !target.isUnstarted
          ? runAddress
          : null;
      const isExternallyOwned = loadedWorkflows.some(
        (workflow) =>
          workflow.externalOwner &&
          workflow.workflowKey === target.address.workflowKey &&
          workflow.runRef === runAddress?.runRef
      );
      const queueDefinitionDisabledTitle = isViewingDeletedWorkflow
        ? "This workflow has been deleted"
        : isSystemGeneratedWorkflow
          ? "Managed automatically by commit message generation"
          : undefined;
      const showQueueNext =
        subWorkflowRunAddress !== null &&
        QUEUE_NEXT_STATES.includes(displayedExecutionState);
      // An externally executing run has no in-memory queue here, and
      // append-and-continue refuses an executing run.
      const queueNextDisabledTitle =
        queueDefinitionDisabledTitle ??
        (isExternallyOwned && isWorkflowActive(displayedExecutionState)
          ? SUB_WORKFLOW_QUEUE_LABELS.externalRun
          : undefined);
      const showRunAlongside =
        subWorkflowRunAddress !== null &&
        displayedExecutionState === EXECUTION_STATES.RUNNING;
      const runAlongsideDisabledTitle =
        queueDefinitionDisabledTitle ??
        (finalStepPhase === FINAL_STEP_PHASES.FINAL_STEP
          ? PARALLEL_DISPATCH_REFUSALS.finalStep
          : effectiveParallelGroupWidth <= 1
            ? PARALLEL_DISPATCH_REFUSALS.widthOne
            : undefined);
      const exportDisabledTitle =
        target.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN
          ? "Export is available for a saved run"
          : target.isExecuting
            ? "Cannot export a run while it is executing"
            : undefined;

      setContextMenu({
        x,
        y,
        items: [
          ...(runAddress
            ? [
                {
                  label: target.isUnstarted
                    ? "Open Unstarted Run"
                    : "New Run (Don't Start)",
                  icon: "codicon-add",
                  disabled: target.isExecuting,
                  title: target.isUnstarted
                    ? "This run has not started yet — open it to edit or run it"
                    : "Create the next run from these steps and settings without running it",
                  disabledTitle: target.isExecuting
                    ? "Cannot prepare a new run while this workflow is executing"
                    : undefined,
                  onClick: () => {
                    onCloseDropdown();
                    sendMessage(MESSAGE_TYPES.PREPARE_NEW_RUN, {
                      address: runAddress,
                    });
                  },
                },
              ]
            : []),
          ...(showQueueNext
            ? [
                {
                  label: SUB_WORKFLOW_QUEUE_LABELS.queueNext,
                  icon: "codicon-list-ordered",
                  disabled: queueNextDisabledTitle !== undefined,
                  title: SUB_WORKFLOW_QUEUE_LABELS.queueNextTitle,
                  disabledTitle: queueNextDisabledTitle,
                  onClick: () => {
                    onCloseDropdown();
                    requestSubWorkflowFile(QUEUE_POSITION.END);
                  },
                },
              ]
            : []),
          ...(showRunAlongside
            ? [
                {
                  label: SUB_WORKFLOW_QUEUE_LABELS.runAlongside,
                  icon: "codicon-split-horizontal",
                  disabled: runAlongsideDisabledTitle !== undefined,
                  title: SUB_WORKFLOW_QUEUE_LABELS.runAlongsideTitle,
                  disabledTitle: runAlongsideDisabledTitle,
                  onClick: () => {
                    onCloseDropdown();
                    requestSubWorkflowFile(
                      QUEUE_POSITION.PARALLEL_WITH_CURRENT
                    );
                  },
                },
              ]
            : []),
          ...(isDisplayedTarget
            ? [
                {
                  label: "Dry Run",
                  icon: "codicon-telescope",
                  disabled: dryRunDisabledTitle !== undefined,
                  title:
                    "Preview what each step would send to its harness, without running anything",
                  disabledTitle: dryRunDisabledTitle,
                  onClick: () => {
                    onCloseDropdown();
                    openWorkflowDryRun();
                  },
                },
              ]
            : []),
          {
            label: "Export Run…",
            icon: "codicon-export",
            disabled: exportDisabledTitle !== undefined,
            disabledTitle: exportDisabledTitle,
            title: "Create a redacted, portable bundle of this run",
            onClick: () => {
              if (target.address.kind !== WORKFLOW_VIEW_ADDRESS_KIND.RUN)
                return;
              onCloseDropdown();
              sendMessage(MESSAGE_TYPES.REQUEST_RUN_EXPORT_INFO, {
                requestId: generateId(),
                address: target.address,
                workflowName: target.workflowName,
              });
            },
          },
          {
            label: "Duplicate Workflow…",
            icon: "codicon-copy",
            disabled: false,
            onClick: () => onDuplicate(target, opener),
          },
          { type: "divider" },
          {
            label: "Copy Workflow Key",
            icon: "codicon-key",
            disabled: false,
            title:
              "Copies the key that prior context's Completed run output uses to import this workflow's runs",
            onClick: () =>
              copyToClipboard(target.address.workflowKey, "Workflow key"),
          },
          {
            label: "Copy Run Directory Path",
            icon: "codicon-copy",
            disabled: !hasRunDirectory,
            title: copyRunDirectoryTitle,
            disabledTitle: hasRunDirectory
              ? undefined
              : `Run directory path is unavailable. ${copyRunDirectoryTitle}`,
            onClick: () => {
              if (!target.runDirectory) return;
              copyToClipboard(target.runDirectory, "Run directory path");
            },
          },
          { type: "divider" },
          {
            label: "Exit Terminal",
            icon: "codicon-debug-stop",
            disabled: exitTerminalDisabledTitle !== undefined,
            title: `Exit this workflow's terminal. ${exitTerminalExplanation}`,
            disabledTitle: exitTerminalDisabledTitle,
            onClick: () => {
              onCloseDropdown();
              sendMessage(MESSAGE_TYPES.EXIT_IDLE_TERMINALS, {
                workflowKey: target.address.workflowKey,
              });
            },
          },
          {
            label: "Exit All Idle Terminals",
            icon: "codicon-debug-stop",
            disabled: activeTerminalWorkflows.length === 0,
            title: `Exit the terminal of every workflow that is not executing or paused. ${exitTerminalExplanation}`,
            disabledTitle:
              activeTerminalWorkflows.length === 0
                ? "No workflow has an open terminal"
                : undefined,
            onClick: () => {
              onCloseDropdown();
              sendMessage(MESSAGE_TYPES.EXIT_IDLE_TERMINALS, {});
            },
          },
          { type: "divider" },
          {
            label: target.schedule
              ? WORKFLOW_SCHEDULE_LABELS.editSchedule
              : WORKFLOW_SCHEDULE_LABELS.schedule,
            icon: "codicon-clock",
            disabled: false,
            title: upcomingScheduleRunLabel(
              target,
              Date.now(),
              useUiStore.getState().hostTimeZone
            ),
            // Opens the schedule panel inside the workflow dropdown, so the
            // dropdown must stay open (it opens it when the menu came from
            // the header).
            onClick: () => onEditSchedule(target, opener),
          },
          {
            label: target.isFavorite
              ? "Remove from Favorites"
              : "Add to Favorites",
            icon: target.isFavorite
              ? "codicon-star-full"
              : "codicon-star-empty",
            disabled: false,
            onClick: () => onToggleFavorite(target.address),
          },
          {
            label: deleteLabel,
            icon: "codicon-trash",
            disabled: target.isExecuting || isDraftRun,
            disabledTitle: deleteDisabledTitle,
            onClick: () => {
              onCloseDropdown();
              onDelete(target);
            },
          },
        ],
      });
    },
    [
      activeTerminalWorkflows,
      displayedExecutionState,
      displayedViewAddress,
      effectiveParallelGroupWidth,
      finalStepPhase,
      isSystemGeneratedWorkflow,
      isViewingDeletedWorkflow,
      loadedWorkflows,
      onCloseDropdown,
      onDelete,
      onDuplicate,
      onEditSchedule,
      onToggleFavorite,
      requestSubWorkflowFile,
    ]
  );

  const workflowContextMenuPortal = (
    <>
      {contextMenu && (
        <ContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
      )}
      {subWorkflowPickerModal}
    </>
  );

  return { openContextMenu, workflowContextMenuPortal };
}
