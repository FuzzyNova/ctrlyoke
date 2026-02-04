import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { PromptEditor } from "../editor/PromptEditor";
import { PanelBar } from "../shared";
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

  if (editorCollapsed) {
    return (
      <PanelBar
        orientation="horizontal"
        icon="edit"
        title="Editor"
        onClick={toggleEditorCollapse}
      />
    );
  }

  return (
    <section
      id="editor-section"
      className="editor-section flex flex-col h-full bg-[var(--vscode-editor-background)]"
    >
      {/* Section Header */}
      <div className="section-header flex items-center px-2 py-1.5 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)]">
        {/* Collapse trigger (chevron + icon) */}
        <div
          className="flex items-center gap-1 cursor-pointer select-none text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] transition-colors flex-shrink-0"
          onClick={toggleEditorCollapse}
          role="button"
          aria-label="Collapse editor"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && toggleEditorCollapse()}
        >
          <i className="codicon codicon-chevron-down text-[12px]" />
          <i className="codicon codicon-edit text-[14px]" />
        </div>

        {/* Mode text */}
        <span className="editor-mode-indicator text-sm font-medium text-[var(--vscode-foreground)] truncate ml-2">
          {getModeText()}
        </span>

        {/* Prompt name input (only in new prompt mode) */}
        {!isEditMode && (
          <input
            type="text"
            className="prompt-name-input flex-1 max-w-xs ml-2 px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
            placeholder="Prompt name (optional)"
            value={promptName}
            onChange={(e) => setPromptName(e.target.value)}
          />
        )}

        {/* New Prompt button (only in edit mode) */}
        {isEditMode && (
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

      {/* Content area */}
      <div className="prompt-editor-wrapper flex flex-1 overflow-hidden relative">
        <PromptEditor />
      </div>
    </section>
  );
};
