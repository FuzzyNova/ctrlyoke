import {
  KEYBOARD_KEYS,
  OUTPUT_TABS,
  type OutputTab,
} from "@root/types/DashboardConstants";
import React from "react";
import { ExpandCollapseAllDiffsButton } from "@components/shared";
import { TerminalSessionIcon } from "@components/output/TerminalSessionIcon";
import type { WorkflowStepEntry } from "@components/output/UndoChangesDialog";
import type { TerminalSession } from "@store/terminalStore";

export interface OutputSectionHeaderProps {
  activeOutputTab: OutputTab;
  activeTerminalSession: TerminalSession | null;
  anyDiffCollapsed: boolean;
  hasOutput: boolean;
  isFindOpen: boolean;
  isExecutionActive: boolean;
  isFullscreen: boolean;
  isHeaderNarrow: boolean;
  isHeaderVeryNarrow: boolean;
  isTerminalCompact: boolean;
  refCallback: (node: HTMLDivElement | null) => void;
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
      className="relative z-header select-none [-webkit-touch-callout:none] flex items-center justify-between gap-[var(--spacing-sm)] h-[30px] pl-2 pr-1 border-b border-panel-border flex-shrink-0 bg-sidebar-bg"
    >
      <div className="flex items-center gap-1">
        <div
          className="flex items-center gap-1 cursor-pointer select-none text-description-fg hover:text-foreground transition-colors"
          onClick={onToggleCollapse}
          role="button"
          aria-label="Collapse output"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === KEYBOARD_KEYS.ENTER) {
              onToggleCollapse();
            }
          }}
        >
          <i className="codicon codicon-chevron-right text-xs rotate-90 transition-transform duration-150" />
        </div>

        {showTerminalTab ? (
          <div className="flex items-center ml-1">
            <button
              className={`fp-tab fp-tab-hc ${activeOutputTab === OUTPUT_TABS.OUTPUT ? "fp-tab-active fp-tab-hc-selected" : "fp-tab-inactive"}`}
              onClick={onSelectOutputTab}
            >
              <i
                className={`codicon codicon-output ${isHeaderNarrow ? "codicon-lg px-1" : "codicon-sm"}`}
              />
              {!isHeaderNarrow && <span>Output</span>}
            </button>
            <button
              className={`fp-tab fp-tab-hc ${activeOutputTab === OUTPUT_TABS.TERMINAL ? "fp-tab-active fp-tab-hc-selected" : "fp-tab-inactive"}`}
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
            >
              <i
                className={`codicon codicon-terminal ${isHeaderNarrow ? "codicon-lg px-1" : "codicon-sm"}`}
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
            <i className="codicon codicon-output text-sm" />
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
              <i className="codicon codicon-sm codicon-remove" />
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
              <i className="codicon codicon-sm codicon-add" />
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
              <i className="codicon codicon-sm codicon-remove" />
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
              <i className="codicon codicon-sm codicon-add" />
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
              onClick={onNewTerminal}
            >
              <i className="codicon codicon-add text-xs" />
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
                  <i className="codicon codicon-trash text-xs" />
                </button>
              )}
          </>
        )}

        {activeOutputTab === OUTPUT_TABS.OUTPUT && (
          <>
            {workflowUndoEntries.length > 0 && (
              <button
                type="button"
                className="flex items-center gap-0.5 px-1 py-0.5 text-xs text-link-fg hover:text-link-active-fg transition-colors min-w-0"
                style={{ touchAction: "manipulation" }}
                title={`Undo workflow changes (${workflowUndoCount} file${workflowUndoCount !== 1 ? "s" : ""})`}
                onClick={onWorkflowUndo}
              >
                <i className="codicon codicon-lg codicon-discard flex-shrink-0" />
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
                onClick={onWorkflowRedo}
              >
                <i className="codicon codicon-lg codicon-redo flex-shrink-0" />
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
              <i className="codicon codicon-lg codicon-search" />
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
              <i className="codicon codicon-lg codicon-share" />
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
          <i
            className={`codicon codicon-lg ${isFullscreen ? "codicon-screen-normal" : "codicon-screen-full"}`}
          />
        </button>
      </div>
    </div>
  );
};
