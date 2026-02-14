import React, { useState, useRef, useEffect, useCallback } from "react";
import { formatRelativeTimeVerbose } from "../../utils/time";
import { getExecutionStateBadgeClass } from "../../utils/status";
import { useWorkflowStore } from "../../store/workflowStore";
import { EXECUTION_STATES } from "../../types/messages";

export interface RunSelectorProps {
  availableRuns: number;
  currentRunIndex: number;    // 0 = newest
  isViewingHistory: boolean;
  isLiveRunActive: boolean;   // whether a workflow is currently executing
  onSelectRun: (runIndex: number) => void;
  onBackToLive: () => void;
  /** startedAt timestamps for each run, index 0 = most recent. Optional. */
  runTimestamps?: (number | undefined)[];
  /** executionState for each run, index 0 = most recent. Optional. */
  runStates?: (string | undefined)[];
}

/**
 * RunSelector Component
 *
 * Dropdown button in the output header that lets the user navigate between
 * historical runs of the current workflow.
 *
 * Displays: "Run N of M ▼" where N = availableRuns - currentRunIndex (run number),
 * M = availableRuns.
 *
 * Dropdown shows runs in newest-first order (index 0 = most recent).
 * Items show number only (no "Run" prefix), status badge, and relative time.
 */
export const RunSelector: React.FC<RunSelectorProps> = ({
  availableRuns,
  currentRunIndex,
  isViewingHistory,
  isLiveRunActive,
  onSelectRun,
  onBackToLive,
  runTimestamps,
  runStates,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Get current execution state from the live workflow
  const { executionState } = useWorkflowStore();

  // Compute the 1-based run number for the current selection
  // Index 0 = most recent = run N, index 1 = run N-1, etc.
  const currentRunNumber = availableRuns - currentRunIndex;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen((prev) => !prev);
  }, []);

  const handleSelectRun = useCallback(
    (runIndex: number) => {
      setIsOpen(false);
      if (isLiveRunActive && runIndex === 0) {
        // Selecting the live run (index 0) while a workflow is active always
        // returns to / stays in live view — never loads the in-progress history file
        onBackToLive();
      } else {
        onSelectRun(runIndex);
      }
    },
    [isLiveRunActive, onSelectRun, onBackToLive]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    },
    []
  );

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-center"
      onKeyDown={handleKeyDown}
    >
      {/* Trigger button */}
      <button
        type="button"
        onClick={handleToggle}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title="Select run to view"
        className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded
          text-[var(--vscode-descriptionForeground)]
          hover:text-[var(--vscode-foreground)]
          hover:bg-[var(--vscode-list-hoverBackground)]
          transition-colors focus:outline-none focus-visible:ring-1
          focus-visible:ring-[var(--vscode-focusBorder)]"
      >
        {isLiveRunActive && !isViewingHistory && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--vscode-charts-green)] animate-pulse mr-0.5" />
        )}
        <span>
          Run {currentRunNumber} of {availableRuns}
        </span>
        <svg
          className={`w-3 h-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          role="listbox"
          aria-label="Select run"
          className="absolute top-full right-0 mt-1 w-max
            bg-[var(--vscode-dropdown-background)]
            border border-[var(--vscode-dropdown-border)]
            rounded shadow-lg z-50 overflow-y-auto overflow-x-hidden py-0.5"
          style={{ maxHeight: "var(--run-selector-max-h, 160px)", minWidth: "160px", maxWidth: "320px" }}
        >
          {Array.from({ length: availableRuns }, (_, i) => {
            // i=0 is most recent, i=1 is second most recent, etc.
            const runNumber = availableRuns - i;
            const isLiveRun = i === 0 && isLiveRunActive;
            const isSelected = i === currentRunIndex;
            const timeAgo = formatRelativeTimeVerbose(runTimestamps?.[i]);
            
            // For the live run (index 0), show the current execution state from the store
            // if it's not actively running. This ensures completed/error states show correctly.
            // For actively running workflows, show "running".
            // For historical runs, use the stored state from runStates.
            let runState: string | undefined;
            if (i === 0) {
              // Most recent run - use live execution state
              runState = executionState === EXECUTION_STATES.IDLE 
                ? runStates?.[i]  // If idle with no workflow, use stored state
                : executionState;  // Otherwise use current live state (running/completed/error)
            } else {
              // Historical run - use stored state
              runState = runStates?.[i];
            }

            return (
              <button
                key={i}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => handleSelectRun(i)}
                className={`w-full text-left px-3 py-1.5 text-[11px] flex items-center gap-2
                  transition-colors
                  ${
                    isSelected
                      ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                      : "text-[var(--vscode-dropdown-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] cursor-pointer"
                  }`}
              >
                {/* Run number with optional live dot inline */}
                <span className="flex items-center gap-1 flex-shrink-0">
                  {isLiveRun && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--vscode-charts-green)] animate-pulse" />
                  )}
                  <span className="font-mono">{runNumber}</span>
                </span>

                {/* Status badge */}
                {runState && (
                  <span
                    className={`text-[10px] px-1 py-[1px] rounded uppercase font-semibold flex-shrink-0 ${getExecutionStateBadgeClass(runState)}`}
                  >
                    {runState}
                  </span>
                )}

                {/* Spacer to push time right */}
                <span className="flex-1 min-w-[8px]" />

                {/* Relative time or "live" label */}
                {isLiveRun ? (
                  <span className="text-[var(--vscode-descriptionForeground)] text-[10px] flex-shrink-0">
                    live
                  </span>
                ) : (
                  timeAgo && (
                    <span className="text-[var(--vscode-descriptionForeground)] text-[10px] flex-shrink-0">
                      {timeAgo}
                    </span>
                  )
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
