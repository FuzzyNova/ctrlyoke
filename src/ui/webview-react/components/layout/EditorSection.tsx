import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { PromptEditor } from "../editor/PromptEditor";
import { EXECUTION_STATES } from "../../types/messages";

/**
 * EditorSection - Collapsible section containing the prompt editor
 *
 * Features:
 * - Collapsible header with title and collapse button
 * - Mode indicator showing "New Prompt" or "Editing: Prompt N of M"
 * - Optional prompt name input in new prompt mode
 * - Contains PromptEditor component
 * - Handles section collapse state persistence
 */
export const EditorSection: React.FC = () => {
  const { selectedPromptIndex, promptName, setPromptName, cancelEdit } =
    useEditorStore();
  const { editorCollapsed, toggleEditorCollapse } = useUiStore();
  const { prompts, executionState } = useWorkflowStore();

  const isEditMode = selectedPromptIndex !== null;
  const totalPrompts = prompts.length;
  const isRunning = executionState === EXECUTION_STATES.RUNNING;

  // Generate mode indicator text
  const getModeText = () => {
    if (isEditMode) {
      return `Editing: Prompt ${(selectedPromptIndex ?? 0) + 1} of ${totalPrompts}`;
    }
    return "New Prompt";
  };

  return (
    <section
      id="editor-section"
      className={`editor-section flex flex-col bg-[var(--vscode-editor-background)] ${
        editorCollapsed ? "collapsed" : ""
      }`}
    >
      {/* Section Header */}
      <div className="section-header flex items-center justify-between px-3 py-2 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)]">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {/* Collapse button */}
          <button
            className="btn-collapse p-1 rounded hover:bg-[var(--vscode-list-hoverBackground)] transition-colors flex-shrink-0"
            onClick={toggleEditorCollapse}
            title={
              editorCollapsed
                ? "Expand editor section"
                : "Collapse editor section"
            }
            aria-label={editorCollapsed ? "Expand editor" : "Collapse editor"}
          >
            <i
              className={`codicon ${
                editorCollapsed
                  ? "codicon-chevron-right"
                  : "codicon-chevron-down"
              } collapse-icon text-[var(--vscode-foreground)]`}
            />
          </button>

          {/* Section icon and title */}
          <i className="codicon codicon-edit text-[var(--vscode-foreground)] flex-shrink-0" />
          <span className="editor-mode-indicator text-sm font-medium text-[var(--vscode-foreground)] truncate">
            {getModeText()}
          </span>

          {/* Prompt name input (only in new prompt mode) */}
          {!isEditMode && !editorCollapsed && (
            <input
              type="text"
              className="prompt-name-input flex-1 max-w-xs px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
              placeholder="Prompt name (optional)"
              value={promptName}
              onChange={(e) => setPromptName(e.target.value)}
            />
          )}

          {/* New Prompt button (only in edit mode) */}
          {isEditMode && !editorCollapsed && (
            <button
              className="btn-new-prompt ml-2 px-2 py-1 text-xs bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] border border-[var(--vscode-button-border,transparent)] rounded hover:bg-[var(--vscode-button-secondaryHoverBackground)] transition-colors flex items-center gap-1"
              onClick={cancelEdit}
              disabled={isRunning}
              title="Cancel editing and return to new prompt mode"
            >
              <i className="codicon codicon-add" />
              <span>New Prompt</span>
            </button>
          )}
        </div>
      </div>

      {/* Content area (hidden when collapsed) */}
      {!editorCollapsed && (
        <div className="prompt-editor-wrapper flex flex-1 overflow-hidden relative">
          <PromptEditor />
        </div>
      )}
    </section>
  );
};
