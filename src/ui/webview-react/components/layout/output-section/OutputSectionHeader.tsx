import { OUTPUT_TABS, type OutputTab } from "@root/types/DashboardConstants";
import React from "react";
import { ExpandCollapseAllDiffsButton } from "@components/shared";
import { TerminalSessionIcon } from "@components/output/TerminalSessionIcon";
import type { WorkflowStepEntry } from "@components/output/UndoChangesDialog";
import type { TerminalSession } from "@store/terminalStore";
import { Icon } from "../../shared/Icon";

export interface OutputSectionHeaderProps {
  activeOutputTab: OutputTab;
  activeTerminalSession: TerminalSession | null;
  anyDiffCollapsed: boolean;
  hasOutput: boolean;
  hiddenOutputCount: number;
  isFindOpen: boolean;
  isExecutionActive: boolean;
  isFullscreen: boolean;
  isHeaderNarrow: boolean;
  isHeaderVeryNarrow: boolean;
  isTerminalCompact: boolean;
  refCallback: (node: HTMLElement | null) => void;
  showTerminalTab: boolean;
  terminalCanCloseActiveSession: boolean;
  /** Executing run identity shown only while a different run/draft is viewed. */
  terminalExecutionRunLabel: string | null;
  terminalFontSize: number;
  terminalSessionActive: boolean;
  useCompactLabels: boolean;
  workflowRedoEntries: WorkflowStepEntry[];
  workflowUndoEntries: WorkflowStepEntry[];
  onCollapseAllDiffs: () => void;
  onExpandAllDiffs: () => void;
  onExport: () => void;
  onToggleFind: () => void;
  onClearHiddenOutputTargets: () => void;
  onNewTerminal: () => void;
  onSelectOutputTab: () => void;
  onSelectTerminalTab: () => void;
  onToggleFullscreen: () => void;
  onTerminalFontSizeChange: (size: number) => void;
  onTerminalSessionClose: () => void;
  onToggleCollapse: () => void;
  onWorkflowRedo: () => void;
  onWorkflowUndo: () => void;
  outputFontSize: number;
  onOutputFontSizeChange: (size: number) => void;
}

export const OutputSectionHeader: React.FC<OutputSectionHeaderProps> = ({
  activeOutputTab,
  activeTerminalSession,
  anyDiffCollapsed,
  hasOutput,
  hiddenOutputCount,
  isFindOpen,
  isExecutionActive,
  isFullscreen,
  isHeaderNarrow,
  isHeaderVeryNarrow,
  isTerminalCompact,
  refCallback,
  showTerminalTab,
  terminalCanCloseActiveSession,
  terminalExecutionRunLabel,
  terminalFontSize,
  terminalSessionActive,
  useCompactLabels,
  workflowRedoEntries,
  workflowUndoEntries,
  onCollapseAllDiffs,
  onExpandAllDiffs,
  onExport,
  onToggleFind,
  onClearHiddenOutputTargets,
  onNewTerminal,
  onSelectOutputTab,
  onSelectTerminalTab,
  onToggleFullscreen,
  onTerminalFontSizeChange,
  onTerminalSessionClose,
  onToggleCollapse,
  onWorkflowRedo,
  onWorkflowUndo,
  outputFontSize,
  onOutputFontSizeChange,
}) => {
  const workflowUndoCount = workflowUndoEntries.reduce(
    (count, entry) => count + (entry.undoCandidates?.length ?? 0),
    0
  );
  const workflowRedoCount = workflowRedoEntries.reduce(
    (count, entry) => count + (entry.redoInstructions?.length ?? 0),
    0
  );

  return (
    <div
      ref={refCallback}
      className="relative z-header cy-no-select flex items-center justify-between gap-[var(--spacing-sm)] h-[30px] pl-2 pr-1 border-b border-panel-border flex-shrink-0 bg-sidebar-bg"
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex appearance-none items-center gap-1 border-0 bg-transparent p-0 text-description-fg transition-colors hover:text-foreground"
          onClick={onToggleCollapse}
          aria-label="Collapse output"
        >
          <Icon
            name="chevron-right"
            className="text-xs rotate-90 transition-transform duration-150"
          />
        </button>

        {showTerminalTab ? (
          <div
            className="flex items-center ml-1"
            role="tablist"
            aria-label="Output views"
          >
            <button
              type="button"
              className={`cy-tab cy-tab-hc ${activeOutputTab === OUTPUT_TABS.OUTPUT ? "cy-tab-active cy-tab-hc-selected" : "cy-tab-inactive"}`}
              onClick={onSelectOutputTab}
              aria-label="Output"
              aria-selected={activeOutputTab === OUTPUT_TABS.OUTPUT}
              role="tab"
            >
              <Icon
                name="output"
                className={`${isHeaderNarrow ? "codicon-lg px-1" : "codicon-sm"}`}
              />
              {!isHeaderNarrow && <span>Output</span>}
            </button>
            <button
              type="button"
              className={`cy-tab cy-tab-hc ${activeOutputTab === OUTPUT_TABS.TERMINAL ? "cy-tab-active cy-tab-hc-selected" : "cy-tab-inactive"}`}
              onClick={onSelectTerminalTab}
              aria-label={
                terminalExecutionRunLabel
                  ? `Terminal · ${terminalExecutionRunLabel}`
                  : "Terminal"
              }
              title={
                terminalExecutionRunLabel
                  ? `Terminal · ${terminalExecutionRunLabel}`
                  : undefined
              }
              aria-selected={activeOutputTab === OUTPUT_TABS.TERMINAL}
              role="tab"
            >
              <Icon
                name="terminal"
                className={`${isHeaderNarrow ? "codicon-lg px-1" : "codicon-sm"}`}
              />
              {!isHeaderNarrow && <span>Terminal</span>}
              {!isHeaderNarrow && terminalExecutionRunLabel && (
                <span className="text-description-fg">
                  · {terminalExecutionRunLabel}
                </span>
              )}
              {terminalSessionActive && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-indicator-success animate-pulse" />
              )}
            </button>
          </div>
        ) : (
          <span className="text-xs font-semibold uppercase tracking-wide text-description-fg ml-1 flex items-center gap-1">
            <Icon name="output" className="text-sm" />
            Output
          </span>
        )}

        {!isHeaderVeryNarrow && activeOutputTab === OUTPUT_TABS.OUTPUT ? (
          <div className="flex items-center ml-2">
            <button
              className="icon-btn py-0 px-0.5"
              title="Decrease font size"
              aria-label="Decrease font size"
              onClick={() => onOutputFontSizeChange(outputFontSize - 1)}
              disabled={outputFontSize <= 10}
            >
              <Icon name="remove" className="codicon-sm" />
            </button>
            {!isHeaderNarrow && (
              <span className="text-xxs text-description-fg tabular-nums w-[20px] text-center select-none">
                {outputFontSize}
              </span>
            )}
            <button
              className="icon-btn py-0 px-0.5"
              title="Increase font size"
              aria-label="Increase font size"
              onClick={() => onOutputFontSizeChange(outputFontSize + 1)}
              disabled={outputFontSize >= 24}
            >
              <Icon name="add" className="codicon-sm" />
            </button>
          </div>
        ) : !isHeaderVeryNarrow && activeOutputTab === OUTPUT_TABS.TERMINAL ? (
          <div className="flex items-center ml-2">
            <button
              className="icon-btn py-0 px-0.5"
              title="Decrease terminal font size"
              aria-label="Decrease terminal font size"
              onClick={() => onTerminalFontSizeChange(terminalFontSize - 1)}
              disabled={terminalFontSize <= 8}
            >
              <Icon name="remove" className="codicon-sm" />
            </button>
            {!isHeaderNarrow && (
              <span className="text-xxs text-description-fg tabular-nums w-[20px] text-center select-none">
                {terminalFontSize}
              </span>
            )}
            <button
              className="icon-btn py-0 px-0.5"
              title="Increase terminal font size"
              aria-label="Increase terminal font size"
              onClick={() => onTerminalFontSizeChange(terminalFontSize + 1)}
              disabled={terminalFontSize >= 24}
            >
              <Icon name="add" className="codicon-sm" />
            </button>
          </div>
        ) : null}
      </div>

      <div
        className={`ml-auto flex items-center ${isHeaderNarrow ? "gap-1" : "gap-2"}`}
      >
        {activeOutputTab === OUTPUT_TABS.TERMINAL && (
          <>
            {isTerminalCompact && activeTerminalSession && (
              <div className="flex items-center gap-1.5 min-w-0 mr-1">
                <TerminalSessionIcon session={activeTerminalSession} />
                <span className="text-xs text-foreground truncate max-w-[120px]">
                  {activeTerminalSession.stepName}
                </span>
              </div>
            )}

            <button
              className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-description-fg hover:text-foreground transition-colors"
              title="New Terminal"
              aria-label="New terminal"
              onClick={onNewTerminal}
            >
              <Icon name="add" className="text-xs" />
              {!isTerminalCompact && <span>New Terminal</span>}
            </button>

            {isTerminalCompact &&
              activeTerminalSession &&
              terminalCanCloseActiveSession && (
                <button
                  className="icon-btn py-0 px-1"
                  title="Close terminal"
                  aria-label="Close terminal"
                  onClick={onTerminalSessionClose}
                  disabled={isExecutionActive && !terminalCanCloseActiveSession}
                >
                  <Icon name="trash" className="text-xs" />
                </button>
              )}
          </>
        )}

        {activeOutputTab === OUTPUT_TABS.OUTPUT && (
          <>
            {hiddenOutputCount > 0 && (
              <button
                type="button"
                className="rounded border border-panel-border px-1.5 py-0.5 text-xs text-description-fg hover:text-foreground transition-colors whitespace-nowrap"
                aria-label={`Show all output steps (${hiddenOutputCount} hidden)`}
                onClick={onClearHiddenOutputTargets}
              >
                {hiddenOutputCount} hidden · Show all
              </button>
            )}
            {workflowUndoEntries.length > 0 && (
              <button
                type="button"
                className="flex items-center gap-0.5 px-1 py-0.5 text-xs text-link-fg hover:text-link-active-fg transition-colors min-w-0"
                style={{ touchAction: "manipulation" }}
                title={`Undo workflow changes (${workflowUndoCount} file${workflowUndoCount !== 1 ? "s" : ""})`}
                aria-label="Undo workflow changes"
                onClick={onWorkflowUndo}
              >
                <Icon name="discard" className="codicon-lg flex-shrink-0" />
                {!isHeaderVeryNarrow && (
                  <span className="text-nowrap">
                    {useCompactLabels
                      ? "Undo"
                      : `Undo ${workflowUndoCount} change${workflowUndoCount !== 1 ? "s" : ""}`}
                  </span>
                )}
              </button>
            )}
            {workflowRedoEntries.length > 0 && (
              <button
                type="button"
                className="flex items-center gap-0.5 px-1 py-0.5 text-xs text-terminal-ansiGreen hover:opacity-80 transition-opacity min-w-0"
                style={{ touchAction: "manipulation" }}
                title={`Redo workflow changes (${workflowRedoCount} file${workflowRedoCount !== 1 ? "s" : ""})`}
                aria-label="Redo workflow changes"
                onClick={onWorkflowRedo}
              >
                <Icon name="redo" className="codicon-lg flex-shrink-0" />
                {!isHeaderVeryNarrow && (
                  <span>
                    {useCompactLabels
                      ? "Redo"
                      : `Redo ${workflowRedoCount} change${workflowRedoCount !== 1 ? "s" : ""}`}
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              className={`icon-btn py-1 px-1 ${
                isFindOpen
                  ? "text-widget-highlight-fg hover:text-widget-highlight-fg-hover"
                  : ""
              }`}
              title="Find in output"
              aria-label="Find in output"
              aria-pressed={isFindOpen}
              onClick={onToggleFind}
            >
              <Icon name="search" className="codicon-lg" />
            </button>
            {hasOutput && (
              <ExpandCollapseAllDiffsButton
                anyDiffCollapsed={anyDiffCollapsed}
                onExpand={onExpandAllDiffs}
                onCollapse={onCollapseAllDiffs}
              />
            )}
            <button
              className="icon-btn py-1 px-1"
              id="export-btn"
              title="Export output to markdown"
              aria-label="Export output to markdown"
              onClick={onExport}
              disabled={!hasOutput}
            >
              <Icon name="share" className="codicon-lg" />
            </button>
          </>
        )}
        <button
          type="button"
          className={`icon-btn py-1 px-1 ${
            isFullscreen
              ? "text-widget-highlight-fg hover:text-widget-highlight-fg-hover"
              : ""
          }`}
          title={isFullscreen ? "Exit full screen" : "Full screen"}
          aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
          aria-pressed={isFullscreen}
          onClick={onToggleFullscreen}
        >
          <Icon
            name={
              isFullscreen ? "codicon-screen-normal" : "codicon-screen-full"
            }
            className="codicon-lg"
          />
        </button>
      </div>
    </div>
  );
};
