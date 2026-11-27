import React, { useCallback, useState } from "react";
import { WorkflowFilePickerModal } from "@components/workflow/WorkflowFilePickerModal";
import { isStandalone, useVsCodeApi } from "@hooks/useVsCodeApi";
import {
  QUEUE_POSITION,
  SUB_WORKFLOW_QUEUE_LABELS,
  type QueuePosition,
} from "@root/types/DashboardConstants";
import type { WorkflowDefinitionMutation } from "@root/types/WebviewMessageTypes";
import {
  getWorkflowDefinitionMutation,
  postSubWorkflowAppend,
} from "@utils/workflowMutation";

interface WorkflowFilePickerOptions<TRequest> {
  /** Ask the extension to open its native picker (the VS Code panel). */
  requestNativePick: (request: TRequest) => void;
  /** Title and action of the hosted browser's picker modal. */
  modalLabels: (request: TRequest) => { title: string; actionLabel: string };
  /** Act on the file picked in the hosted browser's modal. */
  onHostedSelect: (filePath: string, request: TRequest) => void;
}

/**
 * Pick a workflow file. This is the one place that chooses between the two
 * pickers: the VS Code panel lets the extension open its native picker (a
 * router branch over the host's `selectWorkspacePath`); the hosted browser
 * has no access to one, so it picks through `WorkflowFilePickerModal`, which
 * the caller renders. `request` is captured when the pick starts, so the
 * modal acts on what the user chose it for, not on later state.
 */
export function useWorkflowFilePicker<TRequest>({
  requestNativePick,
  modalLabels,
  onHostedSelect,
}: WorkflowFilePickerOptions<TRequest>): {
  requestWorkflowFile: (request: TRequest) => void;
  workflowFilePickerModal: React.ReactNode;
} {
  const [pendingRequest, setPendingRequest] = useState<{
    request: TRequest;
  } | null>(null);

  const requestWorkflowFile = useCallback(
    (request: TRequest) => {
      if (isStandalone) {
        setPendingRequest({ request });
        return;
      }
      requestNativePick(request);
    },
    [requestNativePick]
  );

  const labels = pendingRequest ? modalLabels(pendingRequest.request) : null;
  const workflowFilePickerModal =
    pendingRequest === null || labels === null ? null : (
      <WorkflowFilePickerModal
        isOpen
        title={labels.title}
        actionLabel={labels.actionLabel}
        onClose={() => setPendingRequest(null)}
        onSelect={(filePath) =>
          onHostedSelect(filePath, pendingRequest.request)
        }
      />
    );

  return { requestWorkflowFile, workflowFilePickerModal };
}

interface PendingSubWorkflowQueue {
  position: QueuePosition;
  /** The view the user chose the action on, captured before the modal opens. */
  mutation: WorkflowDefinitionMutation | undefined;
}

/**
 * Pick a workflow file and queue it as a sub-workflow step on the displayed
 * workflow, through `useWorkflowFilePicker`.
 *
 * The hosted modal posts the address and revisions captured when the item was
 * chosen, not when the file is picked, so switching workflows while it is
 * open cannot move the step onto another workflow (the stale revisions are
 * then refused instead).
 */
export function useSubWorkflowFilePicker(): {
  requestSubWorkflowFile: (position: QueuePosition) => void;
  subWorkflowPickerModal: React.ReactNode;
} {
  const vscode = useVsCodeApi();
  const requestNativePick = useCallback(
    ({ position }: PendingSubWorkflowQueue) =>
      postSubWorkflowAppend(vscode, { position }),
    [vscode]
  );
  const { requestWorkflowFile, workflowFilePickerModal } =
    useWorkflowFilePicker<PendingSubWorkflowQueue>({
      requestNativePick,
      modalLabels: ({ position }) =>
        position === QUEUE_POSITION.PARALLEL_WITH_CURRENT
          ? {
              title: SUB_WORKFLOW_QUEUE_LABELS.pickerAlongsideTitle,
              actionLabel: SUB_WORKFLOW_QUEUE_LABELS.pickerAlongsideAction,
            }
          : {
              title: SUB_WORKFLOW_QUEUE_LABELS.pickerTitle,
              actionLabel: SUB_WORKFLOW_QUEUE_LABELS.pickerAction,
            },
      onHostedSelect: (filePath, { position, mutation }) =>
        postSubWorkflowAppend(vscode, { filePath, position, mutation }),
    });

  const requestSubWorkflowFile = useCallback(
    (position: QueuePosition) =>
      requestWorkflowFile({
        position,
        // Only the hosted modal needs it; the native branch posts at once.
        mutation: isStandalone ? getWorkflowDefinitionMutation() : undefined,
      }),
    [requestWorkflowFile]
  );

  return {
    requestSubWorkflowFile,
    subWorkflowPickerModal: workflowFilePickerModal,
  };
}
