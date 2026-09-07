import React, { useCallback } from "react";
import { useElementNarrow } from "../../hooks/useElementNarrow";
import { HarnessQuickPicker } from "./HarnessQuickPicker";
import { ModelQuickPicker } from "./ModelQuickPicker";
import { AgentQuickPicker } from "./AgentQuickPicker";
import { SkillsQuickPicker } from "./SkillsQuickPicker";
import { PermissionsQuickPicker } from "./PermissionsQuickPicker";
import { ContextQuickPicker } from "./ContextQuickPicker";
import { DrawerTabBar } from "../shared/DrawerTabBar";
import type { DrawerPage } from "../../types/drawerPages";
import type { HarnessId } from "../../types/messages";
import type { TabIconOverride } from "../shared/tabBadgeUtils";
import { useEditorStore } from "../../store/editorStore";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import { Icon } from "../shared/Icon";

export const EDITOR_FOOTER_HEIGHT_REM = 2.5;

interface EditorFooterProps {
  isEditMode: boolean;
  isFinalStepMode?: boolean;
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
  isExternallyManaged?: boolean;
  externalReadOnlyLabel?: string;
  /** Active tab page in the properties drawer — drives the inline DrawerTabBar */
  drawerActivePage: DrawerPage;
  onDrawerTabChange: (page: DrawerPage) => void;
  drawerHarnessId: HarnessId;
  drawerTabOverrides?: Partial<Record<DrawerPage, TabIconOverride>>;
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
  isFinalStepMode = false,
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
  isExternallyManaged = false,
  externalReadOnlyLabel,
  drawerActivePage,
  onDrawerTabChange,
  drawerHarnessId,
  drawerTabOverrides,
}) => {
  const [footerRef, isMediumWidth] = useElementNarrow(768);
  const [footerRefSmall, isSmallWidth] = useElementNarrow(400);
  // Must be a stable identity: an inline arrow here is a new function every
  // render, so React detaches and re-attaches it each time, which tears down
  // and rebuilds both ResizeObservers and re-measures on every render.
  const mergedFooterRef = useCallback(
    (node: HTMLDivElement | null) => {
      footerRef(node);
      footerRefSmall(node);
    },
    [footerRef, footerRefSmall]
  );
  const stepType = useEditorStore((s) => s.stepType);
  const isScriptMode = stepType === STEP_TYPES.SCRIPT;

  return (
    <div
      ref={mergedFooterRef}
      className="editor-footer shrink-0 flex items-center gap-1 px-3 h-10 border-t border-panel-border bg-sidebar-bg"
      style={{ height: `${EDITOR_FOOTER_HEIGHT_REM}rem` }}
    >
      {/* Properties toggle button — hidden in script mode */}
      {!isScriptMode && (
        <button
          className={`btn-properties shrink-0 px-2 py-1 text-xs rounded flex items-center gap-1 transition-colors ${
            propertiesOpen
              ? "bg-btn-secondary-bg text-btn-secondary-fg"
              : "hover:bg-list-hover-bg text-foreground"
          }`}
          onClick={onToggleProperties}
          title="Toggle prompt properties"
          aria-label="Toggle prompt properties"
        >
          <Icon name="settings" />
          {!isMediumWidth && <span>Properties</span>}
          {!isMediumWidth && (
            <Icon
              name={
                propertiesOpen ? "codicon-chevron-down" : "codicon-chevron-up"
              }
            />
          )}
        </button>
      )}

      {/* Swappable zone: quick pickers ↔ DrawerTabBar — hidden in script mode */}
      {!isScriptMode && (
        <div className="relative flex-1 min-w-0 self-stretch overflow-hidden">
          {/* Quick pickers — unified layout, exits upward as a single unit */}
          <div
            className={`absolute inset-0 flex items-center justify-between transition-all duration-300 ${
              propertiesOpen
                ? "-translate-y-3 opacity-0 pointer-events-none"
                : "translate-y-0 opacity-100"
            }`}
          >
            <div className="flex items-center gap-1">
              <HarnessQuickPicker
                isNarrow={isMediumWidth}
                showLabel={!isMediumWidth}
                disabled={isExternallyManaged}
              />
              <ModelQuickPicker
                isNarrow={isMediumWidth}
                showLabel={!isMediumWidth}
                disabled={isExternallyManaged}
              />
              <AgentQuickPicker
                isNarrow={isMediumWidth}
                showLabel={!isMediumWidth}
                disabled={isExternallyManaged}
              />
              <SkillsQuickPicker
                isNarrow={isMediumWidth}
                showLabel={!isMediumWidth}
                disabled={isExternallyManaged}
              />
            </div>
            {!(isEditMode && isSmallWidth) && (
              <div className="flex items-center gap-1">
                <PermissionsQuickPicker
                  isNarrow={isMediumWidth}
                  showLabel={!isMediumWidth}
                  disabled={isExternallyManaged}
                />
                <ContextQuickPicker
                  isNarrow={isMediumWidth}
                  showLabel={!isMediumWidth}
                  disabled={isExternallyManaged}
                />
              </div>
            )}
          </div>

          {/* DrawerTabBar — independent full-width layer, enters from below */}
          <div
            className={`absolute inset-0 flex items-center transition-all duration-300 ${
              propertiesOpen
                ? "translate-y-0 opacity-100"
                : "translate-y-3 opacity-0 pointer-events-none"
            }`}
          >
            <DrawerTabBar
              activeTab={drawerActivePage}
              onTabChange={onDrawerTabChange}
              ariaLabel="Prompt properties"
              harnessId={drawerHarnessId}
              isNarrow={isMediumWidth}
              tabOverrides={drawerTabOverrides}
              className="flex items-center w-full h-full"
            />
          </div>
        </div>
      )}

      {/* Spacer for script mode — pushes action buttons to the right */}
      {isScriptMode && <div className="flex-1" />}

      {/* Action buttons — always visible */}
      <div className="flex items-center gap-2 shrink-0 ml-1 pl-2 border-l border-panel-border">
        {isEditMode ? (
          // Edit mode buttons
          <>
            <button
              className="btn-editor-cancel border border-btn-border px-3 py-1 text-xs rounded flex items-center gap-1 bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={onCancel}
              disabled={isExternallyManaged}
              title={
                isExternallyManaged
                  ? (externalReadOnlyLabel ?? "Read-only — external run")
                  : "Cancel editing and return to new prompt mode"
              }
            >
              <Icon name="close" />
              {!isMediumWidth && <span className="btn-text">Cancel</span>}
            </button>

            <button
              className="btn-editor-update border border-btn-border px-3 py-1 text-xs rounded flex items-center gap-1 bg-btn-bg text-btn-fg hover:bg-btn-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={onUpdate}
              disabled={isExternallyManaged || !hasContent || isPromptBeingSent}
              title={
                isExternallyManaged
                  ? (externalReadOnlyLabel ?? "Read-only — external run")
                  : isPromptBeingSent
                    ? "Cannot update a prompt that is currently being sent"
                    : isPromptCompleted
                      ? "Update prompt and reset execution to this step"
                      : "Update prompt in queue"
              }
            >
              <Icon name="check" />
              {!isMediumWidth && <span className="btn-text">Update</span>}
            </button>

            <button
              className="btn-editor-delete border border-btn-border px-3 py-1 text-xs rounded flex items-center gap-1 bg-terminal-ansiRed text-terminal-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={onDelete}
              disabled={isExternallyManaged || isPromptActivelyRunning}
              title={
                isExternallyManaged
                  ? (externalReadOnlyLabel ?? "Read-only — external run")
                  : isFinalStepMode
                    ? "Disable final step"
                    : isPromptActivelyRunning
                      ? "Cannot delete a prompt that is currently running"
                      : "Delete prompt from queue"
              }
            >
              <Icon name="trash" />
              {!isMediumWidth && (
                <span className="btn-text">
                  {isFinalStepMode ? "Disable" : "Delete"}
                </span>
              )}
            </button>
          </>
        ) : (
          // New prompt mode buttons
          <>
            <button
              className="btn-editor-queue border border-btn-border px-3 py-1 text-xs rounded flex items-center gap-1 bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={onQueue}
              disabled={isExternallyManaged || !hasContent}
              aria-label="Queue"
              title={
                isExternallyManaged
                  ? (externalReadOnlyLabel ?? "Read-only — external run")
                  : queueButtonTooltip
              }
            >
              <Icon name="add" />
              {!isMediumWidth && <span className="btn-text">Queue</span>}
            </button>

            <button
              className="btn-editor-run border border-btn-border px-3 py-1 text-xs rounded flex items-center gap-1 bg-btn-bg text-btn-fg hover:bg-btn-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={onRun}
              disabled={isExternallyManaged || !hasContent}
              aria-label="Run"
              title={
                isExternallyManaged
                  ? (externalReadOnlyLabel ?? "Read-only — external run")
                  : runButtonTooltip
              }
            >
              <Icon name="send" />
              {!isMediumWidth && (
                <span className="btn-text">{runButtonText}</span>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
