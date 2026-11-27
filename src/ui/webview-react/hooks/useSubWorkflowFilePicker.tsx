import React, { useCallback, useState } from "react";
import { WorkflowFilePickerModal } from "@components/workflow/WorkflowFilePickerModal";
import { isStandalone, useVsCodeApi } from "@hooks/useVsCodeApi";
import {
  QUEUE_POSITION,
  SUB_WORKFLOW_QUEUE_LABELS,
  type QueuePosition,
} from "@root/types/DashboardConstants";
import { postSubWorkflowAppend } from "@utils/workflowMutation";

/**
 * Pick a workflow file and queue it as a sub-workflow step on the displayed
 * workflow. The VS Code panel lets the extension open its native picker (the
 * router's `selectWorkspacePath` branch); the hosted browser has no access to
 * one, so it picks through `WorkflowFilePickerModal`, rendered by the caller.
 */
export function useSubWorkflowFilePicker(): {
  requestSubWorkflowFile: (position: QueuePosition) => void;
  subWorkflowPickerModal: React.ReactNode;
} {
  const vscode = useVsCodeApi();
  const [pickerPosition, setPickerPosition] = useState<QueuePosition | null>(
    null
  );

  const requestSubWorkflowFile = useCallback(
    (position: QueuePosition) => {
      if (isStandalone) {
        setPickerPosition(position);
        return;
      }
      postSubWorkflowAppend(vscode, { position });
    },
    [vscode]
  );

  const isAlongside = pickerPosition === QUEUE_POSITION.PARALLEL_WITH_CURRENT;
  const subWorkflowPickerModal =
    pickerPosition === null ? null : (
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
        onClose={() => setPickerPosition(null)}
        onSelect={(filePath) =>
          postSubWorkflowAppend(vscode, {
            filePath,
            position: pickerPosition,
          })
        }
      />
    );

  return { requestSubWorkflowFile, subWorkflowPickerModal };
}
