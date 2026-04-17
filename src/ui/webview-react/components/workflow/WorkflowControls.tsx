import React, { useCallback, useState } from "react";
import { isStandalone, useVsCodeApi } from "@hooks/useVsCodeApi";
import { useWorkflowStore } from "@store/workflowStore";
import { MESSAGE_TYPES } from "@/types/messages";
import {
  SplitButton,
  type SplitButtonOption,
} from "@components/shared/SplitButton";
import { WorkflowFilePickerModal } from "@components/workflow/WorkflowFilePickerModal";

interface WorkflowControlsProps {
  /** Additional className for styling */
  className?: string;
}

/**
 * WorkflowControls - Split button for workflow actions
 *
 * Main button: Create new blank workflow
 * Dropdown options:
 *   - From Template
 *   - Load from File
 *   - Queue File - only when queue exists
 *
 * Keyboard shortcuts are registered as VS Code keybindings (active when this panel is focused):
 *   - Ctrl+Shift+N: New blank workflow
 *   - Ctrl+Shift+T: From template
 *   - Ctrl+Shift+L: Load from file
 *   - Ctrl+Shift+Q: Queue file
 */
export const WorkflowControls: React.FC<WorkflowControlsProps> = ({
  className = "",
}) => {
  const vscode = useVsCodeApi();
  const { fileName } = useWorkflowStore();
  const [filePickerMode, setFilePickerMode] = useState<"load" | "queue" | null>(
    null
  );

  const hasQueue = fileName !== null;

  // Handle new workflow (clear current)
  const handleNewWorkflow = useCallback(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
  }, [vscode]);

  // Handle from template action
  const handleFromTemplate = useCallback(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
  }, [vscode]);

  // Handle load file action
  const handleLoadFile = useCallback(() => {
    if (isStandalone) {
      setFilePickerMode("load");
      return;
    }
    vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE });
  }, [vscode]);

  // Handle queue file action
  const handleQueueFile = useCallback(() => {
    if (!hasQueue) return;
    if (isStandalone) {
      setFilePickerMode("queue");
      return;
    }
    vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE });
  }, [vscode, hasQueue]);

  const handlePickerSelect = useCallback(
    (filePath: string) => {
      if (filePickerMode === "load") {
        vscode.postMessage({ type: MESSAGE_TYPES.LOAD_WORKFLOW, filePath });
        return;
      }
      if (filePickerMode === "queue") {
        vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE, filePath });
      }
    },
    [filePickerMode, vscode]
  );

  // Build dropdown options
  const dropdownOptions: SplitButtonOption[] = [
    {
      label: "New From Template...",
      value: "from-template",
      icon: <i className="custom-icon icon-from-template" />,
      onClick: handleFromTemplate,
    },
    {
      label: "Load from File...",
      value: "load-file",
      icon: <i className="custom-icon icon-load-from-file" />,
      onClick: handleLoadFile,
    },
    {
      label: "Queue from File...",
      value: "queue-file",
      icon: <i className="custom-icon icon-queue-from-file" />,
      onClick: handleQueueFile,
      disabled: !hasQueue,
    },
  ];

  return (
    <div className={`workflow-controls ${className}`}>
      <SplitButton
        mainLabel={
          <span className="flex items-center gap-1.5">
            <i className="codicon codicon-add py-0.5" />
            <span className="sm:inline hidden">New</span>
          </span>
        }
        mainAction={handleNewWorkflow}
        options={dropdownOptions}
        variant="primary"
        mainTitle="Create new workflow"
        dropdownTitle="More workflow actions"
        dropdownAriaLabel="Open workflow menu"
      />
      <WorkflowFilePickerModal
        isOpen={filePickerMode !== null}
        title={
          filePickerMode === "queue"
            ? "Queue Workflow File"
            : "Load Workflow File"
        }
        actionLabel={filePickerMode === "queue" ? "Queue File" : "Load File"}
        onClose={() => setFilePickerMode(null)}
        onSelect={handlePickerSelect}
      />
    </div>
  );
};
