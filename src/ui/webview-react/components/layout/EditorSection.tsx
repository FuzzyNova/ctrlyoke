import React from "react";
import { useEditorStore } from "@store/editorStore";
import { useUiStore } from "@store/uiStore";
import { PromptEditor, PropertiesDrawer, EditorFooter } from "../editor";

export const EditorSection: React.FC = () => {
  const { selectedPromptIndex, promptName, setPromptName } = useEditorStore();
  const { editorCollapsed, toggleEditorCollapse, propertiesDrawerOpen } =
    useUiStore();

  const isEditMode = selectedPromptIndex !== null;

  return (
    <div className="flex flex-col h-full bg-[var(--vscode-editor-background)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--vscode-panel-border)]">
        <div className="flex items-center gap-2 flex-1">
          <i className="codicon codicon-edit text-[var(--vscode-foreground)]"></i>
          <span className="text-sm font-medium text-[var(--vscode-foreground)]">
            {isEditMode ? "Edit Prompt" : "New Prompt"}
          </span>

          {/* Prompt name input */}
          <input
            type="text"
            className="flex-1 max-w-xs px-2 py-1 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded focus:outline-none focus:border-[var(--vscode-focusBorder)]"
            placeholder="Prompt name (optional)"
            value={promptName}
            onChange={(e) => setPromptName(e.target.value)}
          />
        </div>

        {/* Collapse button */}
        <button
          className="p-1 rounded hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
          onClick={toggleEditorCollapse}
          title={editorCollapsed ? "Expand" : "Collapse"}
        >
          <i
            className={`codicon ${
              editorCollapsed ? "codicon-chevron-right" : "codicon-chevron-down"
            } text-[var(--vscode-foreground)]`}
          ></i>
        </button>
      </div>

      {/* Content area */}
      {!editorCollapsed && (
        <div className="flex flex-1 overflow-hidden">
          {/* Editor area */}
          <div className="flex-1 flex flex-col">
            {/* CodeMirror Editor */}
            <div className="flex-1 overflow-hidden">
              <PromptEditor />
            </div>

            {/* Footer */}
            <EditorFooter />
          </div>

          {/* Properties drawer (conditional) */}
          {propertiesDrawerOpen && (
            <div className="w-80 border-l border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)]">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--vscode-panel-border)]">
                <i className="codicon codicon-settings text-[var(--vscode-foreground)]"></i>
                <h3 className="text-sm font-medium text-[var(--vscode-foreground)]">
                  Prompt Properties
                </h3>
              </div>
              <PropertiesDrawer />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
