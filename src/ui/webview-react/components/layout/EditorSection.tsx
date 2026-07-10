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
const EditorSectionInner: React.FC = () => {
  const {
    selectionTarget,
    promptName,
    setPromptName,
    promptText,
    stepType,
    stepEnabled,
    setStepType,
    setStepEnabled,
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
      const scope =
        globalSettings.settingSources["ui.respectGitignoreForCompletions"] ===
        "workspace"
          ? "workspace"
          : "user";
      vscode.postMessage({
        type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
        path: "ui.respectGitignoreForCompletions",
        value: checked,
        scope,
      });
    },
    [vscode, globalSettings.settingSources]
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
      className="editor-section flex flex-col h-full min-h-0 bg-editor-bg"
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
          <i className="codicon codicon-chevron-right text-xs rotate-90 transition-transform duration-150" />
          <i className="codicon codicon-edit text-sm" />
          {!isNarrow && (
            <span className="text-xs font-semibold uppercase tracking-wide">
              Editor
            </span>
          )}
        </div>

        <div
          className="fp-mode-switch mx-2 select-none [-webkit-touch-callout:none]"
          role="group"
          aria-label="Step type"
        >
          <button
            type="button"
            disabled={isCLIManaged}
            className={`fp-mode-switch-btn ${!isScriptMode ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
            onClick={() => setStepType(STEP_TYPES.PROMPT)}
            title="Prompt step — sends text to an AI harness"
            aria-label="Prompt step"
          >
            <i
              className={`codicon codicon-comment codicon-sm ${isNarrow ? "px-1" : ""}`}
            />
            {!isNarrow && <span>Prompt</span>}
          </button>
          <div className="fp-mode-switch-divider">
            <div className="w-px h-full bg-current opacity-40" />
          </div>
          <button
            type="button"
            disabled={isCLIManaged}
            className={`fp-mode-switch-btn ${isScriptMode ? "fp-mode-switch-btn-active" : "fp-mode-switch-btn-inactive"}`}
            onClick={() => setStepType(STEP_TYPES.SCRIPT)}
            title="Script step — runs a shell command with no AI interaction"
            aria-label="Script step"
          >
            <i
              className={`codicon codicon-terminal-powershell codicon-sm ${isNarrow ? "px-1" : ""}`}
            />
            {!isNarrow && <span>Script</span>}
          </button>
        </div>

        {/* Center: Enable toggle + Mode text (clickable to edit name) + token count */}
        <div className="flex items-center justify-center flex-1 gap-1 min-w-0">
          {!isCLIManaged && (
            <button
              type="button"
              onClick={() => setStepEnabled(!stepEnabled)}
              title={
                stepEnabled
                  ? "Step is enabled — click to disable"
                  : "Step is disabled — click to enable"
              }
              aria-label={stepEnabled ? "Disable step" : "Enable step"}
              aria-pressed={!stepEnabled}
              className={`control-button flex items-center flex-shrink-0 px-0.5 bg-transparent border-none leading-none transition-colors ${
                !stepEnabled
                  ? "text-warning-fg hover:text-warning-fg cursor-pointer"
                  : "text-description-fg hover:text-foreground cursor-pointer"
              }`}
            >
              <i
                className={`codicon text-sm ${stepEnabled ? "codicon-check" : "codicon-circle-slash"}`}
              />
            </button>
          )}
          <span className="editor-mode-indicator text-center text-xs text-description-fg truncate min-w-0">
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
                placeholder="Step name (optional)"
                aria-label="Step name"
                className="px-1.5 py-0.5 text-xs bg-input-bg text-input-fg border border-focus-border rounded outline-none w-48"
                style={{ boxShadow: "0 0 0 1px var(--vscode-focusBorder)" }}
              />
            ) : (
              <span
                className={`cursor-pointer hover:text-foreground transition-colors${!stepEnabled ? " italic" : ""}`}
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
            {!isEditingName &&
              (!stepEnabled ? (
                <>
                  {" — "}
                  <span className="italic text-warning-fg">disabled</span>
                </>
              ) : !isScriptMode ? (
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
              ) : null)}
          </span>
        </div>

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
      <div className="prompt-editor-wrapper flex flex-1 min-h-0 overflow-hidden relative">
        <PromptEditor isCLIManaged={isCLIManaged} />
      </div>
    </section>
  );
};

EditorSectionInner.displayName = "EditorSection";

export const EditorSection = React.memo(EditorSectionInner);
