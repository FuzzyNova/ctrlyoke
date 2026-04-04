import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  useWorkflowStore,
  useWorkflowTemporalStore,
} from "@store/workflowStore";
import type { UndoableWorkflowState } from "@store/workflowStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";

interface UndoRedoControlProps {
  isRunning: boolean;
  isPaused: boolean;
}

function describeChange(
  prev: UndoableWorkflowState,
  next: UndoableWorkflowState
): string {
  if (prev.workflowName !== next.workflowName) {
    return `Renamed to "${next.workflowName ?? "Untitled"}"`;
  }

  const prevLen = prev.prompts.length;
  const nextLen = next.prompts.length;

  if (nextLen > prevLen) return `Added prompt ${nextLen}`;
  if (nextLen < prevLen) return `Deleted prompt ${prevLen}`;

  const prevFinal = prev.finalPrompt;
  const nextFinal = next.finalPrompt;
  if (!prevFinal && nextFinal) return "Added final prompt";
  if (prevFinal && !nextFinal) return "Removed final prompt";
  if (prevFinal && nextFinal && prevFinal.prompt !== nextFinal.prompt)
    return "Edited final prompt";

  for (let i = 0; i < nextLen; i++) {
    const p = prev.prompts[i];
    const n = next.prompts[i];
    if (!p || !n) continue;
    if (p.prompt !== n.prompt) return `Edited prompt ${i + 1}`;
    if (p.harness !== n.harness) return `Changed harness on prompt ${i + 1}`;
    if (p.model !== n.model) return `Changed model on prompt ${i + 1}`;
    if (p.agent !== n.agent) return `Changed agent on prompt ${i + 1}`;
    if (JSON.stringify(p.endCondition) !== JSON.stringify(n.endCondition))
      return `Changed end condition on prompt ${i + 1}`;
  }

  return "Changed workflow";
}

export const UndoRedoControl: React.FC<UndoRedoControlProps> = ({
  isRunning,
  isPaused,
}) => {
  const vscode = useVsCodeApi();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const canUndo = useWorkflowTemporalStore((s) => s.pastStates.length > 0);
  const canRedo = useWorkflowTemporalStore((s) => s.futureStates.length > 0);
  const pastStates = useWorkflowTemporalStore((s) => s.pastStates);

  const editingDisabled = isRunning || isPaused;

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  const syncToVsCode = useCallback(() => {
    const { prompts, finalPrompt } = useWorkflowStore.getState();
    vscode.postMessage({ type: MESSAGE_TYPES.UNDO_REDO_SYNC, prompts, finalPrompt });
  }, [vscode]);

  const handleUndo = useCallback(() => {
    if (!canUndo || editingDisabled) return;
    useWorkflowStore.temporal.getState().undo();
    syncToVsCode();
  }, [canUndo, editingDisabled, syncToVsCode]);

  const handleRedo = useCallback(() => {
    if (!canRedo || editingDisabled) return;
    useWorkflowStore.temporal.getState().redo();
    syncToVsCode();
  }, [canRedo, editingDisabled, syncToVsCode]);

  const handleJumpTo = useCallback(
    (undoCount: number) => {
      if (editingDisabled) return;
      const temporal = useWorkflowStore.temporal.getState();
      for (let i = 0; i < undoCount; i++) {
        temporal.undo();
      }
      syncToVsCode();
      setIsOpen(false);
    },
    [editingDisabled, syncToVsCode]
  );

  // Build history list: most-recent first.
  // pastStates[length-1] = one undo away; pastStates[0] = furthest back.
  // The label for entry di describes what changed FROM that past state TO the
  // state that followed it (either another past state or the current state).
  const historyEntries = React.useMemo(() => {
    if (pastStates.length === 0) return [];
    const s = useWorkflowStore.getState();
    const current: UndoableWorkflowState = {
      prompts: s.prompts ?? [],
      workflowName: s.workflowName ?? null,
      finalPrompt: s.finalPrompt ?? null,
      currentStep: s.currentStep ?? 0,
    };
    // zundo types pastStates as Partial<T>[] but partialize always returns full
    // UndoableWorkflowState, so the cast is safe.
    const reversed = ([...pastStates] as UndoableWorkflowState[]).reverse(); // reversed[0] = most recent past
    return reversed.map((state, di) => {
      const nextState = di === 0 ? current : reversed[di - 1];
      return { label: describeChange(state, nextState), undoCount: di + 1 };
    });
  }, [pastStates]);

  const btnBase =
    "inline-flex items-center justify-center px-2 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-1";
  const activeClass =
    "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover";
  const disabledClass =
    "bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed";
  const separatorClass = "bg-btn-secondary-bg text-btn-secondary-fg py-1 flex-shrink-0";

  const undoDisabled = !canUndo || editingDisabled;
  const redoDisabled = !canRedo || editingDisabled;
  const chevronDisabled = pastStates.length === 0 || editingDisabled;

  return (
    <div
      ref={containerRef}
      className="relative inline-flex rounded border border-btn-border overflow-hidden"
      role="group"
      aria-label="Undo / Redo"
    >
      {/* Undo */}
      <button
        type="button"
        className={`${btnBase} ${undoDisabled ? disabledClass : activeClass}`}
        onClick={handleUndo}
        disabled={undoDisabled}
        title="Undo"
        aria-label="Undo"
      >
        <i className="codicon codicon-discard" />
      </button>

      {/* Separator */}
      <div className={separatorClass}>
        <div className="w-px h-full bg-current opacity-40" />
      </div>

      {/* Redo */}
      <button
        type="button"
        className={`${btnBase} ${redoDisabled ? disabledClass : activeClass}`}
        onClick={handleRedo}
        disabled={redoDisabled}
        title="Redo"
        aria-label="Redo"
      >
        <i className="codicon codicon-redo" />
      </button>

      {/* Separator */}
      <div className={separatorClass}>
        <div className="w-px h-full bg-current opacity-40" />
      </div>

      {/* History chevron */}
      <button
        type="button"
        className={`${btnBase} px-1.5 ${chevronDisabled ? disabledClass : activeClass} ${isOpen ? "bg-btn-secondary-hover" : ""}`}
        onClick={() => !chevronDisabled && setIsOpen((o) => !o)}
        disabled={chevronDisabled}
        title="Undo history"
        aria-label="Show undo history"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <svg
          className="w-3 h-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {/* Dropdown */}
      <div
        role="listbox"
        className={`absolute top-full left-0 mt-1 min-w-[220px] max-h-[280px] overflow-y-auto bg-dropdown-bg border border-dropdown-border rounded shadow-lg z-50 transition-all duration-150 origin-top ${
          isOpen && historyEntries.length > 0
            ? "opacity-100 translate-y-0 visible"
            : "opacity-0 -translate-y-1 invisible pointer-events-none"
        }`}
      >
        {historyEntries.map(({ label, undoCount }) => (
          <button
            key={undoCount}
            type="button"
            role="option"
            onClick={() => handleJumpTo(undoCount)}
            className="w-full text-left px-3 py-1.5 text-sm text-dropdown-fg hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer flex items-center gap-2"
          >
            <i className="codicon codicon-discard text-description-fg text-xs flex-shrink-0" />
            <span className="flex-1 truncate">{label}</span>
            {undoCount === 1 && (
              <kbd className="text-xs text-description-fg bg-keybinding-bg px-1.5 py-0.5 rounded font-mono flex-shrink-0">
                Ctrl+Z
              </kbd>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};
