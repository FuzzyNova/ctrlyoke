import React, { useCallback } from "react";
import { SplitButton, type SplitButtonOption } from "../shared/SplitButton";
import { useWorkflowStore } from "../../store/workflowStore";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES, EXECUTION_STATES } from "../../types/messages";

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
  const { fileName, executionState } = useWorkflowStore();

  const isRunning = executionState === EXECUTION_STATES.RUNNING;
  const isPaused = executionState === EXECUTION_STATES.PAUSED;
  const isExecuting = isRunning || isPaused;
  const hasQueue = fileName !== null;

  // Handle new workflow (clear current)
  const handleNewWorkflow = useCallback(() => {
    if (isExecuting) return;
    vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
  }, [vscode, isExecuting]);

  // Handle from template action
  const handleFromTemplate = useCallback(() => {
    if (isExecuting) return;
    vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
  }, [vscode, isExecuting]);

  // Handle load file action
  const handleLoadFile = useCallback(() => {
    if (isExecuting) return;
    vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE });
  }, [vscode, isExecuting]);

  // Handle queue file action
  const handleQueueFile = useCallback(() => {
    if (!hasQueue || isExecuting) return;
    vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE });
  }, [vscode, hasQueue, isExecuting]);

  // Handle save to file action
  const handleSaveToFile = useCallback(() => {
    if (!hasQueue) return;
    vscode.postMessage({ type: MESSAGE_TYPES.SAVE_WORKFLOW_REQUEST });
  }, [vscode, hasQueue]);

  // Build dropdown options
  const dropdownOptions: SplitButtonOption[] = [
    {
      label: "New From Template...",
      value: "from-template",
      icon: <i className="custom-icon icon-from-template" />,
      onClick: handleFromTemplate,
      disabled: isExecuting,
    },
    {
      label: "Load from File...",
      value: "load-file",
      icon: <i className="custom-icon icon-load-from-file" />,
      onClick: handleLoadFile,
      disabled: isExecuting,
    },
    {
      label: "Queue from File...",
      value: "queue-file",
      icon: <i className="custom-icon icon-queue-from-file" />,
      onClick: handleQueueFile,
      disabled: !hasQueue || isExecuting,
    },
    {
      label: "Save to File...",
      value: "save-file",
      icon: <i className="codicon codicon-save" />,
      onClick: handleSaveToFile,
      disabled: !hasQueue,
    },
  ];

  return (
    <div className={`workflow-controls ${className}`}>
      <SplitButton
        mainLabel={
          <span className="flex items-center gap-1.5">
            <i className="codicon codicon-add" />
            <span>New</span>
          </span>
        }
        mainAction={handleNewWorkflow}
        options={dropdownOptions}
        variant="primary"
        mainDisabled={isExecuting}
        mainTitle={
          isExecuting
            ? "Cannot clear workflow while running (stop first)"
            : "Clear current workflow and start blank"
        }
        dropdownTitle="More workflow actions"
        dropdownAriaLabel="Open workflow menu"
      />
    </div>
  );
};
