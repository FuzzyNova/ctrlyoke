import React, { useCallback } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";

/**
 * SaveWorkflowButton
 *
 * A single icon button that opens the Save Workflow dialog.
 * Disabled when no workflow is loaded.
 *
 * Click → posts SAVE_WORKFLOW_REQUEST → extension responds with
 * SAVE_WORKFLOW_DIALOG_DATA → useMessageHandler opens the dialog.
 */
export const SaveWorkflowButton: React.FC = () => {
  const vscode = useVsCodeApi();
  const hasWorkflow = useWorkflowStore((s) => s.fileName !== null);

  const handleSave = useCallback(() => {
    if (!hasWorkflow) return;
    vscode.postMessage({ type: MESSAGE_TYPES.SAVE_WORKFLOW_REQUEST });
  }, [vscode, hasWorkflow]);

  return (
    <button
      className={`control-button flex items-center justify-center min-w-[28px] px-1 py-0.5 text-sm rounded border border-btn-border transition-colors ${
        hasWorkflow
          ? "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
          : "bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed"
      }`}
      onClick={handleSave}
      disabled={!hasWorkflow}
      title={hasWorkflow ? "Save workflow as..." : "No workflow to save"}
      aria-label="Save workflow"
    >
      <i className="codicon codicon-lg codicon-save" />
    </button>
  );
};
