import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  useWorkflowStore,
  useWorkflowTemporalStore,
} from "@store/workflowStore";
import type { UndoableWorkflowState } from "@store/workflowStore";
import { useSettingsStore } from "@store/settingsStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";

interface UndoRedoControlProps {
  isRunning: boolean;
  isPaused: boolean;
  onAction?: (
    action: "undo-click" | "redo-click" | "history-toggle" | "history-jump",
    details: {
      canUndo: boolean;
      canRedo: boolean;
      pastCount: number;
      futureCount: number;
      editingDisabled: boolean;
      historyEntryCount: number;
      isOpen?: boolean;
      stepCount?: number;
      direction?: "undo" | "redo";
    }
  ) => void;
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

  // Workflow-level property changes (SettingsDrawer)
  const prevWP = prev.undoWorkflowProperties ?? {};
  const nextWP = next.undoWorkflowProperties ?? {};
  if (prevWP.harness !== nextWP.harness) return `Changed workflow harness`;
  if (prevWP.model !== nextWP.model) return `Changed workflow model`;
  if (prevWP.agent !== nextWP.agent) return `Changed workflow agent`;
  if (JSON.stringify(prevWP.skills) !== JSON.stringify(nextWP.skills))
    return `Changed workflow skills`;
  if (prevWP.additionalArgs !== nextWP.additionalArgs)
    return `Changed workflow additional args`;
  if (JSON.stringify(prevWP.priorContext) !== JSON.stringify(nextWP.priorContext))
    return `Changed workflow prior context`;
  if (prevWP.resumeSession !== nextWP.resumeSession)
    return nextWP.resumeSession ? `Enabled resume session` : `Disabled resume session`;
  if (prevWP.sessionId !== nextWP.sessionId) return `Changed session ID`;
  if (JSON.stringify(prevWP.endCondition) !== JSON.stringify(nextWP.endCondition))
    return `Changed workflow end condition`;
  if (JSON.stringify(prevWP.mcpServers) !== JSON.stringify(nextWP.mcpServers))
    return `Changed workflow MCP servers`;
  if (JSON.stringify(prevWP.hooks) !== JSON.stringify(nextWP.hooks))
    return `Changed workflow hooks`;
  if (JSON.stringify(prevWP.toolPermissions) !== JSON.stringify(nextWP.toolPermissions))
    return `Changed workflow tool permissions`;

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
    if (JSON.stringify(p.skills) !== JSON.stringify(n.skills))
      return `Changed skills on prompt ${i + 1}`;
    if (JSON.stringify(p.mcpServers) !== JSON.stringify(n.mcpServers))
      return `Changed MCP servers on prompt ${i + 1}`;
    if (JSON.stringify(p.hooks) !== JSON.stringify(n.hooks))
      return `Changed hooks on prompt ${i + 1}`;
    if (JSON.stringify(p.toolPermissions) !== JSON.stringify(n.toolPermissions))
      return `Changed tool permissions on prompt ${i + 1}`;
    if (p.additionalArgs !== n.additionalArgs)
      return `Changed additional args on prompt ${i + 1}`;
    if (JSON.stringify(p.priorContext) !== JSON.stringify(n.priorContext))
      return `Changed prior context on prompt ${i + 1}`;
  }

  return "Changed workflow";
}

export const UndoRedoControl: React.FC<UndoRedoControlProps> = ({
  isRunning,
  isPaused,
  onAction,
}) => {
  const vscode = useVsCodeApi();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupPos, setPopupPos] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  } | null>(null);

  const canUndo = useWorkflowTemporalStore((s) => s.pastStates.length > 0);
  const canRedo = useWorkflowTemporalStore((s) => s.futureStates.length > 0);
  const pastStates = useWorkflowTemporalStore((s) => s.pastStates);
  const futureStates = useWorkflowTemporalStore((s) => s.futureStates);

  const editingDisabled = isRunning || isPaused;

  useEffect(() => {
    if (isOpen) {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setPopupPos({
          top: rect.bottom + 4,
          left: rect.left,
          maxHeight: Math.max(window.innerHeight - rect.bottom - 8, 120),
        });
      }
      const updatePosition = () => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        setPopupPos({
          top: rect.bottom + 4,
          left: rect.left,
          maxHeight: Math.max(window.innerHeight - rect.bottom - 8, 120),
        });
      };
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);
      return () => {
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      };
    }
    setPopupPos(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !containerRef.current?.contains(target) &&
        !popupRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  const syncToVsCode = useCallback(() => {
    const ws = useWorkflowStore.getState();
    const workflowProperties = ws.undoWorkflowProperties;
    // Sync workflowProperties back to settingsStore so the UI reflects the restored state
    useSettingsStore.getState().setWorkflowProperties(workflowProperties);
    vscode.postMessage({
      type: MESSAGE_TYPES.UNDO_REDO_SYNC,
      prompts: ws.prompts,
      finalPrompt: ws.finalPrompt,
      workflowProperties,
    });
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
    (stepCount: number, direction: "undo" | "redo") => {
      if (editingDisabled) return;
      const temporal = useWorkflowStore.temporal.getState();
      for (let i = 0; i < stepCount; i++) {
        if (direction === "redo") {
          temporal.redo();
        } else {
          temporal.undo();
        }
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
    const s = useWorkflowStore.getState();
    const current: UndoableWorkflowState = {
      prompts: s.prompts ?? [],
      workflowName: s.workflowName ?? null,
      finalPrompt: s.finalPrompt ?? null,
      currentStep: s.currentStep ?? 0,
      undoWorkflowProperties: s.undoWorkflowProperties ?? {},
    };
    // futureStates[0] = oldest future (last to redo), futureStates[length-1] = most recently undone (first to redo)
    // Display oldest-future first (top) so the most steps appear at the top, matching undo ordering.
    const typedFuture = futureStates as UndoableWorkflowState[];
    const undoStates = ([...pastStates] as UndoableWorkflowState[]).reverse();

    const redoEntries = typedFuture.map((state, i) => {
      // prevState is the state that was current just before this future state was recorded
      const prevState = i === typedFuture.length - 1 ? current : typedFuture[i + 1];
      return {
        label: describeChange(prevState, state),
        stepCount: typedFuture.length - i,
        direction: "redo" as const,
      };
    });

    const undoEntries = undoStates.map((state, di) => {
      const nextState = di === 0 ? current : undoStates[di - 1];
      return {
        label: describeChange(state, nextState),
        stepCount: di + 1,
        direction: "undo" as const,
      };
    });

    return [...redoEntries, ...undoEntries];
  }, [futureStates, pastStates]);

  const btnBase =
    "inline-flex items-center justify-center px-2 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-1";
  const activeClass =
    "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover";
  const disabledClass =
    "bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed";
  const separatorClass = "bg-btn-secondary-bg text-btn-secondary-fg py-1 flex-shrink-0";

  const undoDisabled = !canUndo || editingDisabled;
  const redoDisabled = !canRedo || editingDisabled;
  const chevronDisabled = historyEntries.length === 0 || editingDisabled;

  const getDebugDetails = useCallback(
    (
      overrides: Partial<{
        isOpen: boolean;
        stepCount: number;
        direction: "undo" | "redo";
      }> = {}
    ) => ({
      canUndo,
      canRedo,
      pastCount: pastStates.length,
      futureCount: futureStates.length,
      editingDisabled,
      historyEntryCount: historyEntries.length,
      ...overrides,
    }),
    [
      canRedo,
      canUndo,
      editingDisabled,
      futureStates.length,
      historyEntries.length,
      pastStates.length,
    ]
  );

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
        onClick={() => {
          onAction?.("undo-click", getDebugDetails());
          handleUndo();
        }}
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
        onClick={() => {
          onAction?.("redo-click", getDebugDetails());
          handleRedo();
        }}
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
        onClick={() => {
          const nextOpen = !isOpen;
          onAction?.(
            "history-toggle",
            getDebugDetails({ isOpen: nextOpen })
          );
          if (!chevronDisabled) {
            setIsOpen(nextOpen);
          }
        }}
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
      {isOpen &&
        historyEntries.length > 0 &&
        popupPos &&
        createPortal(
          <div
            ref={popupRef}
            role="listbox"
            className="fixed min-w-[220px] overflow-y-auto bg-dropdown-bg border border-dropdown-border rounded shadow-lg z-[9999]"
            style={{
              top: popupPos.top,
              left: popupPos.left,
              maxHeight: Math.min(popupPos.maxHeight, 280),
            }}
          >
            {historyEntries.map(({ label, stepCount, direction }) => (
              <button
                key={`${direction}-${stepCount}`}
                type="button"
                role="option"
                onClick={() => {
                  onAction?.(
                    "history-jump",
                    getDebugDetails({ stepCount, direction, isOpen: false })
                  );
                  handleJumpTo(stepCount, direction);
                }}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer flex items-center gap-2 ${
                  direction === "redo"
                    ? "text-dropdown-fg opacity-80"
                    : "text-dropdown-fg"
                }`}
              >
                <i
                  className={`codicon ${
                    direction === "redo"
                      ? "codicon-redo"
                      : "codicon-discard"
                  } text-description-fg text-xs flex-shrink-0`}
                />
                <span className="flex-1 truncate">{label}</span>
                {stepCount === 1 && (
                  <kbd className="text-xs text-description-fg bg-keybinding-bg px-1.5 py-0.5 rounded font-mono flex-shrink-0">
                    {direction === "redo" ? "Ctrl+Y" : "Ctrl+Z"}
                  </kbd>
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
};
