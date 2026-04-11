import React, { useState, useRef, useEffect, useCallback } from "react";
import { useEditorStore } from "../../store/editorStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { useAttachmentTokenCount } from "../../hooks/useAttachmentTokenCount";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { PromptEditor } from "../editor/PromptEditor";
import { PanelBar, IconToggleButton } from "../shared";
import {
  FINAL_STEP_PHASES,
  RUNNER_IDS,
  EDITOR_TARGET_KINDS,
  MESSAGE_TYPES,
} from "../../types/messages";
import { STEP_TYPES } from "@root/types/DashboardConstants";
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
  const {
    selectionTarget,
    promptName,
    setPromptName,
    promptText,
    stepType,
    setStepType,
  } = useEditorStore();
  const tokenCount = useAttachmentTokenCount(promptText);
  const {
    editorCollapsed,
    toggleEditorCollapse,
    loadedWorkflows,
    activeWorkflowId,
  } = useUiStore();
  const { steps } = useWorkflowStore();
  const { globalSettings } = useSettingsStore();
  const vscode = useVsCodeApi();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const isCLIManaged =
    loadedWorkflows.find((w) => w.id === activeWorkflowId)?.managedBy ===
    RUNNER_IDS.CLI;

  const isEditMode = selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT;
  const totalPrompts = steps.length;
  const [sectionRef, isNarrow] = useElementNarrow<HTMLElement>(600);

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

  const handleRespectGitignoreChange = useCallback(
    (checked: boolean) => {
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
        path: "ui.respectGitignoreForCompletions",
        value: checked,
        scope: "user",
      });
    },
    [vscode]
  );

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") saveNameEdit();
    else if (e.key === "Escape") cancelNameEdit();
  };

  const isScriptMode = stepType === STEP_TYPES.SCRIPT;

  // Generate mode indicator text (includes name when set)
  const getModeText = () => {
    if (isEditMode) {
      if (promptName) return `Editing: ${promptName}`;
      if (selectionTarget.kind === FINAL_STEP_PHASES.FINAL_STEP) {
        return isScriptMode ? "Editing: Final Script" : "Editing: Final Step";
      }
      if (isScriptMode) return "Editing: Script";
      return `Editing: Prompt ${selectionTarget.index + 1} of ${totalPrompts}`;
    }
    if (promptName) return `New: ${promptName}`;
    return isScriptMode ? "New Script" : "New Prompt";
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
      <div className="flex items-center h-[30px] pl-2 pr-1 border-b border-panel-border bg-sidebar-bg">
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
          {!isNarrow && (
            <span className="text-[11px] font-semibold uppercase tracking-wide">
              Editor
            </span>
          )}
        </div>

        {/* Step type toggle — Prompt | Script */}
        {!isCLIManaged && (
          <div
            className="relative inline-flex rounded border overflow-hidden flex-shrink-0 mx-2"
            role="group"
            aria-label="Step type"
          >
            <button
              type="button"
              className={`inline-flex items-center justify-center px-2 py-0.5 text-xs transition-colors focus:outline-none ${
                !isScriptMode
                  ? "bg-btn-bg text-btn-fg"
                  : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              }`}
              onClick={() => setStepType(STEP_TYPES.PROMPT)}
              title="Prompt step — sends text to an AI harness"
            >
              <i className="codicon codicon-comment" />
              {!isNarrow && <span className="ml-1">Prompt</span>}
            </button>
            <div className="bg-btn-secondary-bg text-btn-secondary-fg py-1 flex-shrink-0">
              <div className="w-px h-full bg-current opacity-40" />
            </div>
            <button
              type="button"
              className={`inline-flex items-center justify-center px-2 py-0.5 text-xs transition-colors focus:outline-none ${
                isScriptMode
                  ? "bg-btn-bg text-btn-fg"
                  : "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover"
              }`}
              onClick={() => setStepType(STEP_TYPES.SCRIPT)}
              title="Script step — runs a shell command with no AI interaction"
            >
              <i className="codicon codicon-terminal-powershell" />
              {!isNarrow && <span className="ml-1">Script</span>}
            </button>
          </div>
        )}

        {/* Center: Mode text (clickable to edit name) + token count */}
        <span className="editor-mode-indicator flex-1 text-center text-xs text-description-fg truncate min-w-0">
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
              aria-label="Prompt name"
              className="px-1.5 py-0.5 text-xs bg-input-bg text-input-fg border border-focus-border rounded outline-none w-48"
              style={{ boxShadow: "0 0 0 1px var(--vscode-focusBorder)" }}
            />
          ) : (
            <span
              className="cursor-pointer hover:text-foreground transition-colors"
              role="button"
              tabIndex={0}
              onClick={startNameEditing}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  startNameEditing();
                }
              }}
              title="Click to set prompt name"
            >
              {getModeText()}
            </span>
          )}
          {!isEditingName && !isScriptMode && (
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

        {/* Right: Git ignore toggle */}
        {!isCLIManaged && (
          <IconToggleButton
            active={globalSettings.respectGitignore}
            onToggle={handleRespectGitignoreChange}
            activeIcon="repo-selected"
            inactiveIcon="repo"
            activeTooltip="Respecting .gitignore for completions"
            inactiveTooltip="All files included for completions (ignoring .gitignore)"
            activeLabel="Excluding ignored files"
            inactiveLabel="Including all files"
            narrow={isNarrow}
            labelPosition="left"
          />
        )}
      </div>

      {/* Content area */}
      <div className="prompt-editor-wrapper flex flex-1 overflow-hidden relative">
        <PromptEditor isCLIManaged={isCLIManaged} />
      </div>
    </section>
  );
};
