import React, { useState, useRef, useEffect, useCallback } from "react";
import { useEditorStore } from "../../store/editorStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { useAttachmentTokenCount } from "../../hooks/useAttachmentTokenCount";
import { PromptEditor } from "../editor/PromptEditor";
import { PanelBar } from "../shared";
import {
  FINAL_PROMPT_PHASES,
  RUNNER_IDS,
  EDITOR_TARGET_KINDS,
} from "../../types/messages";
import { triggerPanelAnimation } from "@utils/panelAnimation";

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
  const { selectionTarget, promptName, setPromptName, promptText } =
    useEditorStore();
  const tokenCount = useAttachmentTokenCount(promptText);
  const {
    editorCollapsed,
    toggleEditorCollapse,
    loadedWorkflows,
    activeWorkflowId,
  } = useUiStore();
  const { prompts } = useWorkflowStore();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy ===
    RUNNER_IDS.CLI;

  const isEditMode = selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT;
  const totalPrompts = prompts.length;
  const [sectionRef] = useElementNarrow<HTMLElement>();

  // Inline name editing state
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameEditValue, setNameEditValue] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  const startNameEditing = useCallback(() => {
    if (isCLIManaged) return;
    setNameEditValue(promptName);
    setIsEditingName(true);
  }, [isCLIManaged, promptName]);

  const saveNameEdit = useCallback(() => {
    setPromptName(nameEditValue.trim());
    setIsEditingName(false);
  }, [nameEditValue, setPromptName]);

  const cancelNameEdit = useCallback(() => {
    setIsEditingName(false);
  }, []);

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") saveNameEdit();
    else if (e.key === "Escape") cancelNameEdit();
  };

  // Generate mode indicator text (includes name when set)
  const getModeText = () => {
    if (isEditMode) {
      if (promptName) return `Editing: ${promptName}`;
      if (selectionTarget.kind === FINAL_PROMPT_PHASES.FINAL_PROMPT) {
        return "Editing: Final Prompt";
      }
      return `Editing: Prompt ${selectionTarget.index + 1} of ${totalPrompts}`;
    }
    if (promptName) return `New: ${promptName}`;
    return "New Prompt";
  };

  function handleToggle() {
    triggerPanelAnimation();
    toggleEditorCollapse();
  }

  if (editorCollapsed) {
    return (
      <PanelBar
        orientation="horizontal"
        icon="edit"
        title="Editor"
        onClick={handleToggle}
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
          onClick={handleToggle}
          role="button"
          aria-label="Collapse editor"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && handleToggle()}
        >
          <i className="codicon codicon-chevron-right text-[12px] rotate-90 transition-transform duration-150" />
          <i className="codicon codicon-edit text-[14px]" />
          <span className="text-[11px] font-semibold uppercase tracking-wide">
            Editor
          </span>
        </div>

        {/* Center: Mode text (clickable to edit name) + token count */}
        <span className="editor-mode-indicator flex-1 text-center text-xs text-description-fg truncate">
          {isCLIManaged ? (
            "Read-only — CLI run in progress"
          ) : isEditingName ? (
            <input
              ref={nameInputRef}
              type="text"
              value={nameEditValue}
              onChange={(e) => setNameEditValue(e.target.value)}
              onKeyDown={handleNameKeyDown}
              onBlur={saveNameEdit}
              placeholder="Prompt name (optional)"
              className="px-1.5 py-0.5 text-xs bg-input-bg text-input-fg border border-focus-border rounded outline-none w-48"
              style={{ boxShadow: "0 0 0 1px var(--vscode-focusBorder)" }}
            />
          ) : (
            <span
              className="cursor-pointer hover:text-foreground transition-colors"
              onClick={startNameEditing}
              title="Click to set prompt name"
            >
              {getModeText()}
            </span>
          )}
          {!isEditingName && (
            <>
              {" — "}
              <span
                className={`font-bold tabular-nums ${
                  tokenCount >= 100_000
                    ? "text-error-fg"
                    : tokenCount >= 50_000
                      ? "text-warning-fg"
                      : ""
                }`}
              >
                {tokenCount >= 1_000
                  ? `${(tokenCount / 1_000).toFixed(1)}K`
                  : tokenCount.toString()}{" "}
                tokens
              </span>
            </>
          )}
        </span>
      </div>

      {/* Content area */}
      <div className="prompt-editor-wrapper flex flex-1 overflow-hidden relative">
        <PromptEditor isCLIManaged={isCLIManaged} />
      </div>
    </section>
  );
};
