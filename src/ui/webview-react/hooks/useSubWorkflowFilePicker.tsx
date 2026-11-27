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

interface PendingPick {
  position: QueuePosition;
  /** The view the user chose the action on, captured before the modal opens. */
  mutation: WorkflowDefinitionMutation | undefined;
}

/**
 * Pick a workflow file and queue it as a sub-workflow step on the displayed
 * workflow. This is the one place that chooses between the two pickers: the
 * VS Code panel lets the extension open its native picker (the router's
 * `selectWorkspacePath` branch); the hosted browser has no access to one, so
 * it picks through `WorkflowFilePickerModal`, which the caller renders.
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
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);

  const requestSubWorkflowFile = useCallback(
    (position: QueuePosition) => {
      if (isStandalone) {
        setPendingPick({ position, mutation: getWorkflowDefinitionMutation() });
        return;
      }
      postSubWorkflowAppend(vscode, { position });
    },
    [vscode]
  );

  const isAlongside =
    pendingPick?.position === QUEUE_POSITION.PARALLEL_WITH_CURRENT;
  const subWorkflowPickerModal =
    pendingPick === null ? null : (
      <WorkflowFilePickerModal
        isOpen
        title={
          isAlongside
            ? SUB_WORKFLOW_QUEUE_LABELS.pickerAlongsideTitle
            : SUB_WORKFLOW_QUEUE_LABELS.pickerTitle
        }
        actionLabel={
          isAlongside
            ? SUB_WORKFLOW_QUEUE_LABELS.pickerAlongsideAction
            : SUB_WORKFLOW_QUEUE_LABELS.pickerAction
        }
        onClose={() => setPendingPick(null)}
        onSelect={(filePath) =>
          postSubWorkflowAppend(vscode, {
            filePath,
            position: pendingPick.position,
            mutation: pendingPick.mutation,
          })
        }
      />
    );

  return { requestSubWorkflowFile, subWorkflowPickerModal };
}
