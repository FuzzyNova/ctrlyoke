import React, { useState, useRef, useEffect, useCallback } from "react";

export interface RunSelectorProps {
  availableRuns: number;
  currentRunIndex: number;    // 0 = newest
  isViewingHistory: boolean;
  isLiveRunActive: boolean;   // whether a workflow is currently executing
  onSelectRun: (runIndex: number) => void;
  onBackToLive: () => void;
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
 */
export const RunSelector: React.FC<RunSelectorProps> = ({
  availableRuns,
  currentRunIndex,
  isViewingHistory,
  isLiveRunActive,
  onSelectRun,
  onBackToLive,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
      if (isLiveRunActive && runIndex === 0 && isViewingHistory) {
        // Clicking the most recent run while live is active = back to live
        onBackToLive();
      } else {
        onSelectRun(runIndex);
      }
    },
    [isLiveRunActive, isViewingHistory, onSelectRun, onBackToLive]
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
          className="absolute top-full right-0 mt-1 min-w-[160px]
            bg-[var(--vscode-dropdown-background)]
            border border-[var(--vscode-dropdown-border)]
            rounded shadow-lg z-50 overflow-hidden py-0.5"
        >
          {Array.from({ length: availableRuns }, (_, i) => {
            // i=0 is most recent, i=1 is second most recent, etc.
            const runNumber = availableRuns - i;
            const isLiveRun = i === 0 && isLiveRunActive;
            const isSelected = i === currentRunIndex;

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
                {isLiveRun ? (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--vscode-charts-green)] animate-pulse flex-shrink-0" />
                ) : (
                  <span className="inline-block w-1.5 h-1.5 flex-shrink-0" />
                )}
                <span className="flex-1">Run {runNumber}</span>
                {isLiveRun && (
                  <span className="text-[var(--vscode-descriptionForeground)] text-[10px]">
                    live
                  </span>
                )}
                {!isLiveRun && isSelected && (
                  <i className="codicon codicon-check text-[10px]" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
