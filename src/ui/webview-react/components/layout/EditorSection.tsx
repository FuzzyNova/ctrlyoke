import React, { useState, useRef, useEffect, useCallback } from "react";
import { useEditorStore } from "../../store/editorStore";
import { useUiStore } from "../../store/uiStore";
import { useWorkflowStore } from "../../store/workflowStore";
import { useBulkSelectionGates } from "../../hooks/useBulkSelectionGates";
import { getBulkDisplayValue, MIXED_VALUE } from "../../store/editorStore";
import {
  selectSettingWriteScope,
  useSettingsStore,
} from "../../store/settingsStore";
import { useElementTier } from "../../hooks/useElementNarrow";
import { useAttachmentTokenCount } from "../../hooks/useAttachmentTokenCount";
import { useVsCodeApi } from "../../hooks/useVsCodeApi";
import { formatMagnitude } from "../../utils/number";
import { PromptEditor, type PromptFileAction } from "../editor/PromptEditor";
import { ExecutionModeQuickPicker } from "../editor/ExecutionModeQuickPicker";
import { StepColorQuickPicker } from "../editor/StepColorQuickPicker";
import { PanelBar, IconToggleButton } from "../shared";
import { HARNESS_DISPLAY_NAMES } from "../shared/HarnessDropdown";
import { StatusBanner, STATUS_BANNER_TONES } from "../shared/StatusBanner";
import {
  FINAL_STEP_PHASES,
  EDITOR_TARGET_KINDS,
  MESSAGE_TYPES,
} from "../../types/messages";
import {
  KEYBOARD_KEYS,
  STEP_COLOR_MODES,
  STEP_TYPES,
  EDITOR_PLACEHOLDER_TEXT,
  PROMPT_PROPERTIES,
  BULK_EDIT_DISABLED_REASONS,
} from "@root/types/DashboardConstants";
import { triggerPanelAnimation } from "@utils/panelAnimation";
import { getExternalReadOnlyLabel } from "@utils/externalRunner";
import { formatSessionIdPreview } from "@utils/stepOverrideChips";
import { useActiveWorkflowExternalOwner } from "@hooks/useActiveWorkflowExternalOwner";
import { Icon } from "../shared/Icon";

/** Width tiers for the editor header row, from the section's own content width. */
const EDITOR_HEADER_TIERS = {
  WIDE: "wide",
  NARROW: "narrow",
  COMPACT: "compact",
} as const;
type EditorHeaderTier =
  (typeof EDITOR_HEADER_TIERS)[keyof typeof EDITOR_HEADER_TIERS];

const EDITOR_HEADER_NARROW_THRESHOLD = 600;
// Below this, the name + token count no longer fit on one line without the
// token count truncating away — stack them into two lines instead.
const EDITOR_HEADER_COMPACT_THRESHOLD = 460;

function resolveEditorHeaderTier(width: number): EditorHeaderTier {
  if (width < EDITOR_HEADER_COMPACT_THRESHOLD)
    return EDITOR_HEADER_TIERS.COMPACT;
  if (width < EDITOR_HEADER_NARROW_THRESHOLD) return EDITOR_HEADER_TIERS.NARROW;
  return EDITOR_HEADER_TIERS.WIDE;
}

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
    replyContext,
    cancelReplyToStep,
    stepType,
    stepEnabled,
    setStepType,
    setStepEnabled,
    multiSelection,
    bulkPatch,
  } = useEditorStore();
  const { editorCollapsed, toggleEditorCollapse } = useUiStore();
  const steps = useWorkflowStore((s) => s.steps);
  const { globalSettings } = useSettingsStore();
  const vscode = useVsCodeApi();

  // Derive whether the active workflow is CLI-managed (read-only watch mode)
  const activeExternalOwner = useActiveWorkflowExternalOwner();
  const isExternallyManaged = activeExternalOwner != null;
  const externalReadOnlyLabel = getExternalReadOnlyLabel(activeExternalOwner);

  const isEditMode = selectionTarget.kind !== EDITOR_TARGET_KINDS.NEW_PROMPT;
  const bulkGates = useBulkSelectionGates();
  const isBulkMode = multiSelection !== null;
  const selectedIndices = bulkGates.indices;
  const bulkCapabilities = bulkGates.capabilities;
  const bulkHasLocked = bulkGates.hasLockedStep;
  const bulkEnabled = isBulkMode
    ? getBulkDisplayValue(
        { multiSelection, bulkPatch },
        steps,
        PROMPT_PROPERTIES.ENABLED
      )
    : stepEnabled;
  const bulkUpdateAllowed =
    isBulkMode &&
    Object.keys(bulkPatch).length > 0 &&
    Object.keys(bulkPatch).every((key) =>
      key === PROMPT_PROPERTIES.COLOR
        ? Boolean(bulkCapabilities?.canEditColor)
        : key === PROMPT_PROPERTIES.ENABLED
          ? Boolean(bulkCapabilities?.canToggleEnabled)
          : Boolean(bulkCapabilities?.canEditPromptProperties)
    );
  const bulkUpdateDisabledReason = bulkHasLocked
    ? BULK_EDIT_DISABLED_REASONS.LOCKED_STEPS
    : BULK_EDIT_DISABLED_REASONS.NO_EDITABLE_CHANGE;
  const bulkPromptPropertyDisabledReason =
    bulkGates.promptPropertyDisabledReason;
  const bulkHarnessOptionsDisabled =
    bulkGates.harnessScopedDisabledReason !== undefined;
  const promptsSelected =
    isBulkMode &&
    selectedIndices.every((index) => steps[index]?.type !== STEP_TYPES.SCRIPT);
  const bulkPlaceholder = !isBulkMode
    ? undefined
    : bulkHasLocked
      ? EDITOR_PLACEHOLDER_TEXT.BULK_LOCKED(selectedIndices.length)
      : promptsSelected
        ? EDITOR_PLACEHOLDER_TEXT.BULK_PROMPTS(selectedIndices.length)
        : EDITOR_PLACEHOLDER_TEXT.BULK_STEPS(selectedIndices.length);
  const enabledMixed = bulkEnabled === MIXED_VALUE;
  const bulkToggleDisabledReason = bulkGates.toggleDisabledReason;
  const totalPrompts = steps.length;
  const [promptFileAction, setPromptFileAction] =
    useState<PromptFileAction | null>(null);

  // Steps preceding this prompt — folds into prior-context ($previous, $step:N)
  // token estimates. Editing queue step i: steps 0..i-1 precede it. New prompt
  // or final step: every queue step precedes it. Mirrors PromptEditor.
  const stepCount =
    selectionTarget.kind === FINAL_STEP_PHASES.QUEUE
      ? selectionTarget.index
      : steps.length;
  const tokenCount = useAttachmentTokenCount(promptText, stepCount);

  const [sectionRef, headerTier] = useElementTier<
    EditorHeaderTier,
    HTMLElement
  >(resolveEditorHeaderTier, EDITOR_HEADER_TIERS.WIDE);
  const isNarrow = headerTier !== EDITOR_HEADER_TIERS.WIDE;
  const isCompact = headerTier === EDITOR_HEADER_TIERS.COMPACT;

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
    if (isExternallyManaged) return;
    setNameEditValue(promptName);
    setIsEditingName(true);
  }, [isExternallyManaged, promptName]);

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
        scope: selectSettingWriteScope(
          useSettingsStore.getState(),
          "ui.respectGitignoreForCompletions"
        ),
      });
    },
    [vscode]
  );

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === KEYBOARD_KEYS.ENTER) saveNameEdit();
    else if (e.key === KEYBOARD_KEYS.ESCAPE) cancelNameEdit();
  };

  const isScriptMode = stepType === STEP_TYPES.SCRIPT;

  // Below EDITOR_HEADER_COMPACT_THRESHOLD the name + token count no longer
  // fit on one line without the token count truncating away, so stack them.
  const showStackedTokens =
    isCompact &&
    !isExternallyManaged &&
    !isEditingName &&
    !isBulkMode &&
    stepEnabled &&
    !isScriptMode;

  // Generate mode indicator text (includes name when set)
  const getModeText = () => {
    if (isBulkMode)
      return `${selectedIndices.length} ${promptsSelected ? "prompts" : "steps"} selected`;
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

  const replySessionId = replyContext && (
    <span title={replyContext.sessionId}>
      {formatSessionIdPreview(replyContext.sessionId)}
    </span>
  );

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
        <button
          type="button"
          className="flex shrink-0 appearance-none items-center gap-1 border-0 bg-transparent p-0 text-description-fg transition-colors hover:text-foreground"
          onClick={handleToggle}
          aria-label="Collapse editor"
        >
          <Icon
            name="chevron-right"
            className="text-xs rotate-90 transition-transform duration-150"
          />
          <Icon name="edit" className="text-sm" />
          {!isNarrow && (
            <span className="text-xs font-semibold uppercase tracking-wide">
              Editor
            </span>
          )}
        </button>

        <div
          className="cy-mode-switch mx-2 cy-no-select"
          role="group"
          aria-label="Step type"
        >
          <button
            type="button"
            disabled={isExternallyManaged}
            className={`cy-mode-switch-btn ${!isScriptMode ? "cy-mode-switch-btn-active" : "cy-mode-switch-btn-inactive"}`}
            onClick={() => setStepType(STEP_TYPES.PROMPT)}
            title="Prompt step — sends text to an AI harness"
            aria-label="Prompt step"
            aria-pressed={!isScriptMode}
          >
            <Icon
              name="comment"
              className={`codicon-sm ${isNarrow ? "px-1" : ""}`}
            />
            {!isNarrow && <span>Prompt</span>}
          </button>
          <div className="cy-mode-switch-divider">
            <div className="w-px h-full bg-current opacity-40" />
          </div>
          <button
            type="button"
            disabled={isExternallyManaged}
            className={`cy-mode-switch-btn ${isScriptMode ? "cy-mode-switch-btn-active" : "cy-mode-switch-btn-inactive"}`}
            onClick={() => setStepType(STEP_TYPES.SCRIPT)}
            title="Script step — runs a shell command with no AI interaction"
            aria-label="Script step"
            aria-pressed={isScriptMode}
          >
            <Icon
              name="terminal-powershell"
              className={`codicon-sm ${isNarrow ? "px-1" : ""}`}
            />
            {!isNarrow && <span>Script</span>}
          </button>
        </div>

        {/* Center: Enable toggle + Mode text (clickable to edit name) + token count */}
        <div className="flex items-center justify-center flex-1 gap-1 min-w-0">
          {!isExternallyManaged && (
            <button
              type="button"
              onClick={() =>
                setStepEnabled(enabledMixed ? false : !bulkEnabled)
              }
              disabled={isBulkMode && !bulkCapabilities?.canToggleEnabled}
              title={
                bulkToggleDisabledReason ??
                (enabledMixed
                  ? "Steps have mixed enabled states — click to disable all"
                  : bulkEnabled
                    ? "Step is enabled — click to disable"
                    : "Step is disabled — click to enable")
              }
              aria-label={
                enabledMixed
                  ? "Mixed step enabled state"
                  : bulkEnabled
                    ? "Disable step"
                    : "Enable step"
              }
              aria-pressed={!enabledMixed && !bulkEnabled}
              className={`control-button flex items-center shrink-0 px-0.5 bg-transparent border-none leading-none transition-colors ${
                !enabledMixed && !bulkEnabled
                  ? "text-warning-fg hover:text-warning-fg cursor-pointer"
                  : "text-description-fg hover:text-foreground cursor-pointer"
              }`}
            >
              <Icon
                name={
                  enabledMixed
                    ? "remove"
                    : bulkEnabled
                      ? "codicon-check"
                      : "codicon-circle-slash"
                }
                className="text-sm"
              />
            </button>
          )}
          {!isExternallyManaged &&
            globalSettings.stepColorMode !== STEP_COLOR_MODES.NONE && (
              <StepColorQuickPicker
                disabled={
                  isExternallyManaged ||
                  (isBulkMode && !bulkCapabilities?.canEditColor)
                }
              />
            )}
          <span
            data-testid="editor-mode"
            className={`editor-mode-indicator text-center text-xs text-description-fg min-w-0 ${
              showStackedTokens
                ? "flex flex-col items-center leading-tight"
                : "truncate"
            }`}
          >
            {isExternallyManaged ? (
              (externalReadOnlyLabel ?? "Read-only — external run in progress")
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
                className="px-1.5 py-0.5 text-xs bg-input-bg text-input-fg border border-focus-border rounded-sm outline-hidden w-48 max-w-full min-w-0"
                style={{ boxShadow: "0 0 0 1px var(--vscode-focusBorder)" }}
              />
            ) : (
              <button
                type="button"
                className={`max-w-full appearance-none truncate border-0 bg-transparent p-0 text-left font-inherit text-inherit transition-colors hover:text-foreground${!isBulkMode && !stepEnabled ? " italic" : ""}`}
                onClick={isBulkMode ? undefined : startNameEditing}
                disabled={isBulkMode}
                title="Click to set prompt name"
                aria-label="Set prompt name"
              >
                {getModeText()}
              </button>
            )}
            {!isEditingName &&
              (!isBulkMode && !stepEnabled ? (
                <>
                  {" — "}
                  <span className="italic text-warning-fg">disabled</span>
                </>
              ) : !isScriptMode ? (
                <>
                  {!showStackedTokens && " — "}
                  <span
                    className={`font-bold tabular-nums ${
                      tokenCount >= 100_000
                        ? "text-error-fg"
                        : tokenCount >= 50_000
                          ? "text-warning-fg"
                          : ""
                    }`}
                  >
                    {formatMagnitude(tokenCount)} {isNarrow ? "tks" : "tokens"}
                  </span>
                </>
              ) : null)}
          </span>
        </div>

        {/* Right: prompt-file action, step overrides, and Git ignore toggle */}
        {!isExternallyManaged && !isScriptMode && promptFileAction && (
          <button
            type="button"
            onClick={promptFileAction.onClick}
            disabled={promptFileAction.disabled}
            title={promptFileAction.tooltip}
            aria-label={promptFileAction.tooltip}
            className="control-button flex items-center px-1 bg-transparent border-none cursor-pointer leading-none transition-colors select-none disabled:opacity-50 disabled:cursor-not-allowed text-description-fg hover:text-foreground"
          >
            <Icon name={promptFileAction.icon} className="codicon-lg" />
          </button>
        )}
        {!isExternallyManaged && <ExecutionModeQuickPicker />}
        {!isExternallyManaged && (
          <IconToggleButton
            active={globalSettings.respectGitignore}
            onToggle={handleRespectGitignoreChange}
            activeIcon="repo-selected"
            inactiveIcon="repo"
            activeTooltip="Respecting .gitignore for completions"
            inactiveTooltip="All files included for completions (ignoring .gitignore)"
            ariaLabel="Respect .gitignore for completions"
          />
        )}
      </div>

      {selectionTarget.kind === EDITOR_TARGET_KINDS.NEW_PROMPT &&
        !isScriptMode &&
        replyContext && (
          <StatusBanner
            tone={STATUS_BANNER_TONES.INFO}
            icon="reply"
            aria-label={`Replying to ${HARNESS_DISPLAY_NAMES[replyContext.harness]} session ${replyContext.sessionId} (${replyContext.sourceLabel})`}
            narrowChildren={
              <>
                Replying to {HARNESS_DISPLAY_NAMES[replyContext.harness]} ·{" "}
                {replySessionId}
              </>
            }
            action={{
              label: "Cancel",
              onClick: cancelReplyToStep,
              "aria-label": "Cancel reply",
            }}
          >
            Replying to {HARNESS_DISPLAY_NAMES[replyContext.harness]} session{" "}
            {replySessionId}
            <span className="ml-1 opacity-70">
              ({replyContext.sourceLabel})
            </span>
          </StatusBanner>
        )}

      {/* Content area */}
      <div className="prompt-editor-wrapper flex flex-1 min-h-0 overflow-hidden relative">
        <PromptEditor
          isExternallyManaged={isExternallyManaged}
          isBulkMode={isBulkMode}
          bulkPlaceholder={bulkPlaceholder}
          canBulkUpdate={bulkUpdateAllowed}
          bulkUpdateDisabledReason={bulkUpdateDisabledReason}
          canBulkEditPromptProperties={Boolean(
            bulkCapabilities?.canEditPromptProperties
          )}
          bulkPropertyDisabledReason={bulkPromptPropertyDisabledReason}
          bulkHarnessOptionsDisabled={bulkHarnessOptionsDisabled}
          externalReadOnlyLabel={externalReadOnlyLabel}
          onPromptFileActionChange={setPromptFileAction}
        />
      </div>
    </section>
  );
};

EditorSectionInner.displayName = "EditorSection";

export const EditorSection = React.memo(EditorSectionInner);
