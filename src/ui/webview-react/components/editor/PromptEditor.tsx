import React from "react";
import { useEditorStore } from "@store/editorStore";
import { useWorkflowStore } from "@store/workflowStore";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { countTokens } from "@utils/tokenizer";
import { Button } from "../shared";

export const PromptEditor: React.FC = () => {
  const { selectedPromptIndex, promptText, setPromptText, resetEditor } =
    useEditorStore();
  const { executionState } = useWorkflowStore();

  const isEditMode = selectedPromptIndex !== null;
  const tokenCount = countTokens(promptText);

  // Dictionary URIs (hardcoded for now, could come from props)
  const affUri = "./en_US.aff";
  const dicUri = "./en_US.dic";

  const handleRun = () => {
    window.postMessage({
      type: "runPrompt",
      prompt: promptText,
    });
  };

  const handleQueue = () => {
    window.postMessage({
      type: "queuePrompt",
      prompt: promptText,
    });
  };

  const handleUpdate = () => {
    if (selectedPromptIndex === null) return;

    window.postMessage({
      type: "updatePrompt",
      index: selectedPromptIndex,
      prompt: promptText,
      // Include other properties from originalPromptData if needed
    });
  };

  const handleCancel = () => {
    resetEditor();
  };

  const handleDelete = () => {
    if (selectedPromptIndex === null) return;

    if (
      confirm(
        `Are you sure you want to delete prompt ${selectedPromptIndex + 1}?`
      )
    ) {
      window.postMessage({
        type: "deletePrompt",
        index: selectedPromptIndex,
      });
      resetEditor();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        <CodeMirrorEditor
          value={promptText}
          onChange={setPromptText}
          affUri={affUri}
          dicUri={dicUri}
        />
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
        <div className="flex items-center gap-2">
          {/* Token count */}
          <span className="text-xs text-[var(--vscode-descriptionForeground)]">
            {tokenCount} tokens
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isEditMode ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCancel}
                disabled={executionState === "running"}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleUpdate}
                disabled={!promptText.trim() || executionState === "running"}
              >
                Update
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleDelete}
                disabled={executionState === "running"}
              >
                Delete
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleQueue}
                disabled={!promptText.trim() || executionState === "running"}
              >
                Queue
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleRun}
                disabled={!promptText.trim() || executionState === "running"}
              >
                Run
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
