import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useElementNarrow } from "../../hooks/useElementNarrow";
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
  const [sectionRef, isNarrow] = useElementNarrow<HTMLElement>();

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
      ref={sectionRef}
      id="editor-section"
      className="editor-section flex flex-col h-full bg-editor-bg"
    >
      {/* Section Header */}
      <div className="flex items-center h-[30px] px-2 border-b border-panel-border bg-sidebar-bg">
        {/* Left: Collapse trigger (chevron + icon + label) */}
        <div
          className="flex items-center gap-1 cursor-pointer select-none text-description-fg hover:text-foreground transition-colors flex-shrink-0"
          onClick={toggleEditorCollapse}
          role="button"
          aria-label="Collapse editor"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && toggleEditorCollapse()}
        >
          <i className="codicon codicon-chevron-right text-[12px] rotate-90 transition-transform duration-150" />
          <i className="codicon codicon-edit text-[14px]" />
          <span className="text-[11px] font-semibold uppercase tracking-wide">
            Editor
          </span>
        </div>

        {/* Center: Mode text */}
        <span className="editor-mode-indicator flex-1 text-center text-xs text-description-fg truncate">
          {getModeText()}
        </span>

        {/* Right: Prompt name input (only in new prompt mode) */}
        {!isEditMode && (
          <input
            type="text"
            className="prompt-name-input max-w-xs px-2 py-0.5 text-sm bg-input-bg text-input-fg border-0 rounded focus:outline-none flex-shrink-0"
            placeholder="Prompt name (optional)"
            value={promptName}
            onChange={(e) => setPromptName(e.target.value)}
          />
        )}

        {/* Right: New Prompt button (only in edit mode) */}
        {isEditMode && (
          <button
            className="btn-new-prompt px-2 py-1 text-xs bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border rounded hover:bg-btn-secondary-hover transition-colors flex items-center gap-1 flex-shrink-0"
            onClick={cancelEdit}
            disabled={isRunning}
            title="Cancel editing and return to new prompt mode"
          >
            <i className="codicon codicon-add" />
            {!isNarrow && <span>New Prompt</span>}
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
