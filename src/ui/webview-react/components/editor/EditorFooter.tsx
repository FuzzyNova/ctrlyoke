import React from "react";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { HarnessQuickPicker } from "./HarnessQuickPicker";
import { ModelQuickPicker } from "./ModelQuickPicker";
import { AgentQuickPicker } from "./AgentQuickPicker";
import { SkillsQuickPicker } from "./SkillsQuickPicker";
import { PermissionsQuickPicker } from "./PermissionsQuickPicker";
import { ContextQuickPicker } from "./ContextQuickPicker";

interface EditorFooterProps {
  isEditMode: boolean;
  isFinalPromptMode?: boolean;
  isPromptCompleted: boolean;
  /** True when the selected prompt's status is SENT or RUNNING (prevents Update) */
  isPromptBeingSent: boolean;
  /** True when the selected prompt's status is RUNNING specifically (prevents Delete) */
  isPromptActivelyRunning: boolean;
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
  /** When true, all edit actions are disabled (CLI watch mode). */
  isCLIManaged?: boolean;
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
  isFinalPromptMode = false,
  isPromptCompleted,
  isPromptBeingSent,
  isPromptActivelyRunning,
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
  isCLIManaged = false,
}) => {
  const [footerRef, isNarrow] = useElementNarrow(768);

  return (
    <div
      ref={footerRef}
      className="editor-footer flex items-center justify-between px-3 py-1.5 border-t border-panel-border bg-sidebar-bg"
    >
      {/* Left side: Properties toggle + all four quick pickers */}
      <div className="editor-footer-left flex items-center gap-1">
        <button
          className={`btn-properties px-2 py-1 text-xs rounded flex items-center gap-1 transition-colors ${
            propertiesOpen
              ? "bg-btn-secondary-bg text-btn-secondary-fg"
              : "hover:bg-list-hover-bg text-foreground"
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
        <div
          className={`flex items-center gap-1 transition-all duration-300 ${
            propertiesOpen
              ? "-translate-y-3 opacity-0 pointer-events-none"
              : "translate-y-0 opacity-100"
          }`}
        >
          <HarnessQuickPicker
            isNarrow={isNarrow}
            showLabel={!isNarrow}
            disabled={isCLIManaged}
          />
          <ModelQuickPicker
            isNarrow={isNarrow}
            showLabel={!isNarrow}
            disabled={isCLIManaged}
          />
          <AgentQuickPicker
            isNarrow={isNarrow}
            showLabel={!isNarrow}
            disabled={isCLIManaged}
          />
          <SkillsQuickPicker
            isNarrow={isNarrow}
            showLabel={!isNarrow}
            disabled={isCLIManaged}
          />
        </div>
      </div>

      {/* Right side: Permissions + Context pickers, then action buttons */}
      <div className="editor-actions flex items-center gap-1">
        <div
          className={`flex items-center gap-1 transition-all duration-300 ${
            propertiesOpen
              ? "-translate-y-3 opacity-0 pointer-events-none"
              : "translate-y-0 opacity-100"
          }`}
        >
          <PermissionsQuickPicker
            isNarrow={isNarrow}
            showLabel={!isNarrow}
            disabled={isCLIManaged}
          />
          <ContextQuickPicker
            isNarrow={isNarrow}
            showLabel={!isNarrow}
            disabled={isCLIManaged}
          />
        </div>
        <div
          className={`flex items-center gap-2 transition-all duration-300 ${!propertiesOpen ? "ml-1 pl-2 border-l border-panel-border" : ""}`}
        >
          {isEditMode ? (
            // Edit mode buttons
            <>
              <button
                className="btn-editor-cancel px-3 py-1 text-xs rounded flex items-center gap-1 bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                onClick={onCancel}
                disabled={isCLIManaged}
                title={
                  isCLIManaged
                    ? "Read-only — workflow is running via FlightPath CLI"
                    : "Cancel editing and return to new prompt mode"
                }
              >
                <i className="codicon codicon-close" />
                {!isNarrow && <span className="btn-text">Cancel</span>}
              </button>

              <button
                className="btn-editor-update px-3 py-1 text-xs rounded flex items-center gap-1 bg-btn-bg text-btn-fg hover:bg-btn-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                onClick={onUpdate}
                disabled={
                  isCLIManaged ||
                  !hasContent ||
                  isPromptBeingSent ||
                  isPromptCompleted
                }
                title={
                  isCLIManaged
                    ? "Read-only — workflow is running via FlightPath CLI"
                    : isPromptCompleted
                      ? "Cannot edit a completed prompt — use Clear workflow state to reset"
                      : isPromptBeingSent
                        ? "Cannot update a prompt that is currently being sent"
                        : "Update prompt in queue"
                }
              >
                <i className="codicon codicon-check" />
                {!isNarrow && <span className="btn-text">Update</span>}
              </button>

              <button
                className="btn-editor-delete px-3 py-1 text-xs rounded flex items-center gap-1 bg-input-error-bg text-input-error-fg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                onClick={onDelete}
                disabled={
                  isCLIManaged ||
                  isPromptActivelyRunning ||
                  (!isFinalPromptMode && isPromptCompleted)
                }
                title={
                  isCLIManaged
                    ? "Read-only — workflow is running via FlightPath CLI"
                    : isFinalPromptMode
                      ? "Disable final prompt"
                      : isPromptCompleted
                        ? "Cannot delete a completed prompt — use Clear workflow state to reset"
                        : isPromptActivelyRunning
                          ? "Cannot delete a prompt that is currently running"
                          : "Delete prompt from queue"
                }
              >
                <i className="codicon codicon-trash" />
                {!isNarrow && (
                  <span className="btn-text">
                    {isFinalPromptMode ? "Disable" : "Delete"}
                  </span>
                )}
              </button>
            </>
          ) : (
            // New prompt mode buttons
            <>
              <button
                className="btn-editor-queue px-3 py-1 text-xs rounded flex items-center gap-1 bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                onClick={onQueue}
                disabled={isCLIManaged || !hasContent}
                title={
                  isCLIManaged
                    ? "Read-only — workflow is running via FlightPath CLI"
                    : queueButtonTooltip
                }
              >
                <i className="codicon codicon-add" />
                {!isNarrow && <span className="btn-text">Queue</span>}
              </button>

              <button
                className="btn-editor-run px-3 py-1 text-xs rounded flex items-center gap-1 bg-btn-bg text-btn-fg hover:bg-btn-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                onClick={onRun}
                disabled={isCLIManaged || !hasContent}
                title={
                  isCLIManaged
                    ? "Read-only — workflow is running via FlightPath CLI"
                    : runButtonTooltip
                }
              >
                <i className="codicon codicon-send" />
                {!isNarrow && <span className="btn-text">{runButtonText}</span>}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
