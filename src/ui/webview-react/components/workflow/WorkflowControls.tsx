import React, { useCallback, useEffect } from "react";
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
 * Main button: Create new blank workflow (Ctrl+Shift+N)
 * Dropdown options:
 *   - From Template (Ctrl+Shift+T)
 *   - Load from File (Ctrl+Shift+L)
 *   - Queue File (Ctrl+Shift+Q) - only when queue exists
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

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only trigger if Ctrl+Shift is pressed (or Cmd+Shift on Mac)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        switch (e.key.toUpperCase()) {
          case "N":
            e.preventDefault();
            handleNewWorkflow();
            break;
          case "T":
            e.preventDefault();
            handleFromTemplate();
            break;
          case "L":
            e.preventDefault();
            handleLoadFile();
            break;
          case "Q":
            e.preventDefault();
            if (hasQueue) {
              handleQueueFile();
            }
            break;
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    handleNewWorkflow,
    handleFromTemplate,
    handleLoadFile,
    handleQueueFile,
    hasQueue,
  ]);

  // Build dropdown options
  const dropdownOptions: SplitButtonOption[] = [
    {
      label: "From Template...",
      value: "from-template",
      onClick: handleFromTemplate,
      shortcut: "Ctrl+Shift+T",
      disabled: isExecuting,
    },
    {
      label: "Load from File...",
      value: "load-file",
      onClick: handleLoadFile,
      shortcut: "Ctrl+Shift+L",
      disabled: isExecuting,
    },
    {
      label: "",
      value: "divider-1",
      onClick: () => {},
      divider: true,
    },
    {
      label: "Queue File...",
      value: "queue-file",
      onClick: handleQueueFile,
      shortcut: "Ctrl+Shift+Q",
      disabled: !hasQueue || isExecuting,
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
            : "Clear current workflow and start blank (Ctrl+Shift+N)"
        }
        dropdownTitle="More workflow actions"
        dropdownAriaLabel="Open workflow menu"
      />
    </div>
  );
};
