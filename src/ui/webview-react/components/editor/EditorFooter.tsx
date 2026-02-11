import React from "react";
import { useEditorStore } from "../../store/editorStore";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { countTokens } from "../../utils/tokenizer";

interface EditorFooterProps {
  isEditMode: boolean;
  isRunning: boolean;
  hasContent: boolean;
  hasPendingPrompts: boolean;
  runButtonText: string;
  runButtonTooltip: string;
  queueButtonTooltip: string;
  onRun: () => void;
  onQueue: () => void;
  onUpdate: () => void;
  onDelete: () => void;
  onCancel: () => void;
  onToggleProperties: () => void;
  propertiesOpen: boolean;
}

/**
 * EditorFooter - Bottom bar of the prompt editor
 *
 * Features:
 * - Token count display (left side)
 * - Properties drawer toggle button
 * - Action buttons based on mode:
 *   - New mode: Run, Queue buttons
 *   - Edit mode: Update, Delete, Cancel buttons
 * - Proper enable/disable states
 */
export const EditorFooter: React.FC<EditorFooterProps> = ({
  isEditMode,
  isRunning,
  hasContent,
  hasPendingPrompts: _hasPendingPrompts, // Reserved for future use
  runButtonText,
  runButtonTooltip,
  queueButtonTooltip,
  onRun,
  onQueue,
  onUpdate,
  onDelete,
  onCancel,
  onToggleProperties,
  propertiesOpen,
}) => {
  const { promptText } = useEditorStore();
  const tokenCount = countTokens(promptText);
  const [footerRef, isNarrow] = useElementNarrow();

  return (
    <div
      ref={footerRef}
      className="editor-footer flex items-center justify-between px-3 py-1 border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)]"
    >
      {/* Left side: Properties toggle */}
      <div className="editor-footer-left flex items-center">
        <button
          className={`btn-properties px-2 py-1 text-xs rounded flex items-center gap-1 transition-colors ${
            propertiesOpen
              ? "bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]"
              : "hover:bg-[var(--vscode-list-hoverBackground)] text-[var(--vscode-foreground)]"
          }`}
          onClick={onToggleProperties}
          title="Toggle prompt properties"
        >
          <i className="codicon codicon-settings-gear" />
          {!isNarrow && <span>Properties</span>}
          {!isNarrow && (
            <i
              className={`codicon ${propertiesOpen ? "codicon-chevron-down" : "codicon-chevron-up"}`}
            />
          )}
        </button>
      </div>

      {/* Center: Token count */}
      <div className="editor-footer-center flex items-center justify-center flex-1">
        <span className="editor-metadata text-xs text-[var(--vscode-descriptionForeground)]">
          <i className="codicon codicon-symbol-misc mr-1" />
          <span className="editor-token-count">
            {tokenCount.toLocaleString()} token{tokenCount !== 1 ? "s" : ""}
          </span>
        </span>
      </div>

      {/* Right side: Action buttons */}
      <div className="editor-actions flex items-center gap-2">
        {isEditMode ? (
          // Edit mode buttons
          <>
            <button
              className="btn-editor-cancel px-3 py-1 text-xs rounded flex items-center gap-1 bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={onCancel}
              disabled={isRunning}
              title="Cancel editing and return to new prompt mode"
            >
              <i className="codicon codicon-close" />
              {!isNarrow && <span className="btn-text">Cancel</span>}
            </button>

            <button
              className="btn-editor-update px-3 py-1 text-xs rounded flex items-center gap-1 bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={onUpdate}
              disabled={!hasContent || isRunning}
              title="Update prompt in queue"
            >
              <i className="codicon codicon-check" />
              {!isNarrow && <span className="btn-text">Update</span>}
            </button>

            <button
              className="btn-editor-delete px-3 py-1 text-xs rounded flex items-center gap-1 bg-[var(--vscode-inputValidation-errorBackground,#5a1d1d)] text-[var(--vscode-inputValidation-errorForeground,#f48771)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={onDelete}
              disabled={isRunning}
              title="Delete prompt from queue"
            >
              <i className="codicon codicon-trash" />
              {!isNarrow && <span className="btn-text">Delete</span>}
            </button>
          </>
        ) : (
          // New prompt mode buttons
          <>
            <button
              className="btn-editor-queue px-3 py-1 text-xs rounded flex items-center gap-1 bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={onQueue}
              disabled={!hasContent || isRunning}
              title={queueButtonTooltip}
            >
              <i className="codicon codicon-add" />
              {!isNarrow && <span className="btn-text">Queue</span>}
            </button>

            <button
              className="btn-editor-run px-3 py-1 text-xs rounded flex items-center gap-1 bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] hover:bg-[var(--vscode-button-hoverBackground)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={onRun}
              disabled={!hasContent || isRunning}
              title={runButtonTooltip}
            >
              <i className="codicon codicon-send" />
              {!isNarrow && <span className="btn-text">{runButtonText}</span>}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
