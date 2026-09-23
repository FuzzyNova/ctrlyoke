import { useCallback, useState } from "react";
import {
  StepContextMenu,
  type StepContextMenuState,
} from "@components/shared/StepContextMenu";
import type { WorkflowViewAddress } from "@root/types/CtrlYokeTypes";
import {
  MESSAGE_TYPES,
  USER_FEEDBACK_SEVERITY,
  WORKFLOW_DELETE_SCOPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
  type WorkflowDeleteScope,
} from "@root/types/DashboardConstants";
import { writeClipboardText } from "@utils/stepClipboard";
import { notifyUser } from "@utils/notifyUser";
import { sendMessage } from "@hooks/useMessageHandler";

export interface WorkflowContextMenuTarget {
  address: WorkflowViewAddress;
  workflowName: string;
  /**
   * "lineage" — the whole workflow (list rows, header). Delete removes it and
   * all its history.
   * "run" — one addressed run inside a lineage (run-panel rows). Delete removes
   * only that run.
   */
  scope: Exclude<WorkflowDeleteScope, typeof WORKFLOW_DELETE_SCOPES.ALL>;
  /** Lineage-scoped on every surface, including run-panel rows. */
  isFavorite?: boolean;
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
}

const copyRunDirectoryTitle =
  "Copies the path; in hosted browser mode, it is on the server's filesystem.";

export function useWorkflowContextMenu({
  onDuplicate,
  onToggleFavorite,
  onDelete,
  onCloseDropdown,
}: UseWorkflowContextMenuOptions) {
  const [contextMenu, setContextMenu] = useState<StepContextMenuState | null>(
    null
  );

  const openContextMenu = useCallback(
    (
      x: number,
      y: number,
      target: WorkflowContextMenuTarget,
      opener: HTMLElement | null = null
    ) => {
      const hasRunDirectory = Boolean(target.runDirectory);
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
          {
            label: "Duplicate Workflow…",
            icon: "codicon-copy",
            disabled: false,
            onClick: () => onDuplicate(target, opener),
          },
          { type: "divider" },
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
              void writeClipboardText(target.runDirectory)
                .then(() => {
                  notifyUser(
                    "Run directory path copied to clipboard",
                    USER_FEEDBACK_SEVERITY.SUCCESS
                  );
                })
                .catch(() => {
                  notifyUser(
                    "Failed to copy run directory path",
                    USER_FEEDBACK_SEVERITY.ERROR
                  );
                });
            },
          },
          { type: "divider" },
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
    [onCloseDropdown, onDelete, onDuplicate, onToggleFavorite]
  );

  const workflowContextMenuPortal = contextMenu ? (
    <StepContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />
  ) : null;

  return { openContextMenu, workflowContextMenuPortal };
}
