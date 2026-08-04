import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  useWorkflowStore,
  useWorkflowTemporalStore,
} from "@store/workflowStore";
import type { UndoableWorkflowState, WorkflowStep } from "@store/workflowStore";
import { useSettingsStore } from "@store/settingsStore";
import { useIsMobile } from "@hooks/useMediaQuery";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import {
  mergeRuntimeForUndoRedo,
  rememberUndoRedoRuntime,
} from "@hooks/useUndoRedoKeyHandler";
import { MESSAGE_TYPES } from "../../types/messages";
import { STEP_STATUS } from "../../types/messages";
import { DEFAULT_WORKFLOW_NAME } from "@root/types/DashboardConstants";
import { HEADER_BUTTON_SIZES } from "@/constants";
import { postWorkflowDefinitionMutation } from "../../utils/workflowMutation";

interface UndoRedoControlProps {
  isRunning: boolean;
  isPaused: boolean;
  embedded?: boolean;
  showHistoryChevronOnDesktopOnly?: "sm" | "lg";
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

const UNDO_LABEL_TRUNCATE = 20;

function truncateVal(val: string): string {
  return val.length > UNDO_LABEL_TRUNCATE
    ? val.slice(0, UNDO_LABEL_TRUNCATE) + "…"
    : val;
}

function strVal(val: string | number | null | undefined): string {
  if (val === null || val === undefined || val === "") return "none";
  return truncateVal(String(val));
}

function stripTransientStepFields(step: WorkflowStep | null): unknown {
  if (!step) return null;
  const {
    status: _status,
    _runtime: _runtime,
    ...stableStep
  } = step as WorkflowStep & {
    status?: unknown;
    _runtime?: unknown;
  };
  return stableStep;
}

type RuntimeDecoratedStep = WorkflowStep & {
  status?: (typeof STEP_STATUS)[keyof typeof STEP_STATUS];
  _runtime?: WorkflowStep["_runtime"];
};

function getStepStatus(step?: WorkflowStep | null) {
  return (step as RuntimeDecoratedStep | undefined | null)?.status;
}

function isTerminalStatus(
  status: RuntimeDecoratedStep["status"]
): status is
  | typeof STEP_STATUS.COMPLETED
  | typeof STEP_STATUS.FAILED
  | typeof STEP_STATUS.CANCELLED
  | typeof STEP_STATUS.SKIPPED {
  return (
    status === STEP_STATUS.COMPLETED ||
    status === STEP_STATUS.FAILED ||
    status === STEP_STATUS.CANCELLED ||
    status === STEP_STATUS.SKIPPED
  );
}

function sameEditableStep(
  a?: WorkflowStep | null,
  b?: WorkflowStep | null
): boolean {
  return (
    JSON.stringify(stripTransientStepFields(a ?? null)) ===
    JSON.stringify(stripTransientStepFields(b ?? null))
  );
}

function reconcileStepRuntime(
  restoredStep: WorkflowStep,
  previousStep?: WorkflowStep
): WorkflowStep {
  const restoredStatus = getStepStatus(restoredStep);
  const previousStatus = getStepStatus(previousStep);

  if (!previousStep || !sameEditableStep(previousStep, restoredStep)) {
    if (
      restoredStatus === STEP_STATUS.RUNNING ||
      restoredStatus === STEP_STATUS.SENT
    ) {
      return {
        ...(restoredStep as RuntimeDecoratedStep),
        status: STEP_STATUS.PENDING,
      } as WorkflowStep;
    }
    return restoredStep;
  }

  const restoredTerminal = isTerminalStatus(restoredStatus);
  const previousTerminal = isTerminalStatus(previousStatus);

  if (previousTerminal && !restoredTerminal) {
    return {
      ...(restoredStep as RuntimeDecoratedStep),
      status: previousStatus,
      _runtime: (previousStep as RuntimeDecoratedStep)._runtime,
    } as WorkflowStep;
  }

  return restoredStep;
}

function deriveCurrentStep(steps: WorkflowStep[]): number {
  let nextCurrentStep = 0;
  for (const step of steps) {
    if (!isTerminalStatus(getStepStatus(step))) {
      break;
    }
    nextCurrentStep += 1;
  }
  return nextCurrentStep;
}

interface PromptChangeFields {
  prompt?: string | null;
  harness?: string | null;
  model?: string | null;
  agent?: string | null;
  errorBehavior?: unknown;
  endCondition?: unknown;
  preCondition?: unknown;
  skills?: unknown;
  mcpServers?: unknown;
  hooks?: unknown;
  toolPermissions?: unknown;
  additionalArgs?: string | null;
  priorContext?: unknown;
  enabled?: boolean;
}

function describePromptChange(
  scope: string,
  p: PromptChangeFields,
  n: PromptChangeFields
): string | null {
  if (p.prompt !== n.prompt) return `Edited ${scope}`;
  if (p.harness !== n.harness)
    return `Changed harness on ${scope} to ${strVal(n.harness)}`;
  if (p.model !== n.model)
    return `Changed model on ${scope} to ${strVal(n.model)}`;
  if (p.agent !== n.agent)
    return `Changed agent on ${scope} to ${strVal(n.agent)}`;
  if (JSON.stringify(p.errorBehavior) !== JSON.stringify(n.errorBehavior))
    return `Changed error behavior on ${scope}`;
  if (JSON.stringify(p.endCondition) !== JSON.stringify(n.endCondition))
    return `Changed end condition on ${scope}`;
  if (JSON.stringify(p.preCondition) !== JSON.stringify(n.preCondition))
    return `Changed pre condition on ${scope}`;
  if (JSON.stringify(p.skills) !== JSON.stringify(n.skills))
    return `Changed skills on ${scope}`;
  if (JSON.stringify(p.mcpServers) !== JSON.stringify(n.mcpServers))
    return `Changed MCP servers on ${scope}`;
  if (JSON.stringify(p.hooks) !== JSON.stringify(n.hooks))
    return `Changed hooks on ${scope}`;
  if (JSON.stringify(p.toolPermissions) !== JSON.stringify(n.toolPermissions))
    return `Changed tool permissions on ${scope}`;
  if (p.additionalArgs !== n.additionalArgs)
    return `Changed additional args on ${scope} to ${strVal(n.additionalArgs)}`;
  if (JSON.stringify(p.priorContext) !== JSON.stringify(n.priorContext))
    return `Changed prior context on ${scope}`;
  if (p.enabled !== n.enabled)
    return n.enabled === false ? `Disabled ${scope}` : `Enabled ${scope}`;
  return null;
}

function describeChange(
  prev: UndoableWorkflowState,
  next: UndoableWorkflowState
): string {
  if (prev.workflowName !== next.workflowName) {
    return `Renamed to "${next.workflowName ?? DEFAULT_WORKFLOW_NAME}"`;
  }

  const prevLen = prev.steps.length;
  const nextLen = next.steps.length;

  if (nextLen > prevLen) return `Added prompt ${nextLen}`;
  if (nextLen < prevLen) return `Deleted prompt ${prevLen}`;

  const prevFinal = prev.finalStep;
  const nextFinal = next.finalStep;
  if (!prevFinal && nextFinal) return "Added final step";
  if (prevFinal && !nextFinal) return "Removed final step";
  if (prevFinal && nextFinal) {
    const change = describePromptChange(
      "final step",
      prevFinal as PromptChangeFields,
      nextFinal as PromptChangeFields
    );
    if (change) return change;
  }

  // Workflow-level property changes (WorkflowPropertiesPanel)
  const prevWP = prev.undoWorkflowProperties ?? {};
  const nextWP = next.undoWorkflowProperties ?? {};
  if (prevWP.harness !== nextWP.harness)
    return `Changed workflow harness to ${strVal(nextWP.harness)}`;
  if (prevWP.model !== nextWP.model)
    return `Changed workflow model to ${strVal(nextWP.model)}`;
  if (prevWP.agent !== nextWP.agent)
    return `Changed workflow agent to ${strVal(nextWP.agent)}`;
  if (JSON.stringify(prevWP.skills) !== JSON.stringify(nextWP.skills))
    return `Changed workflow skills`;
  if (prevWP.additionalArgs !== nextWP.additionalArgs)
    return `Changed workflow additional args to ${strVal(nextWP.additionalArgs)}`;
  if (
    JSON.stringify(prevWP.priorContext) !== JSON.stringify(nextWP.priorContext)
  )
    return `Changed workflow prior context`;
  if (prevWP.resumeSession !== nextWP.resumeSession)
    return nextWP.resumeSession
      ? `Enabled resume session`
      : `Disabled resume session`;
  if (prevWP.sessionId !== nextWP.sessionId)
    return `Changed session ID to ${strVal(nextWP.sessionId)}`;
  if (
    JSON.stringify(prevWP.errorBehavior) !==
    JSON.stringify(nextWP.errorBehavior)
  )
    return `Changed workflow error behavior`;
  if (
    JSON.stringify(prevWP.endCondition) !== JSON.stringify(nextWP.endCondition)
  )
    return `Changed workflow end condition`;
  if (
    JSON.stringify(prevWP.preCondition) !== JSON.stringify(nextWP.preCondition)
  )
    return `Changed workflow pre condition`;
  if (JSON.stringify(prevWP.mcpServers) !== JSON.stringify(nextWP.mcpServers))
    return `Changed workflow MCP servers`;
  if (JSON.stringify(prevWP.hooks) !== JSON.stringify(nextWP.hooks))
    return `Changed workflow hooks`;
  if (
    JSON.stringify(prevWP.toolPermissions) !==
    JSON.stringify(nextWP.toolPermissions)
  )
    return `Changed workflow tool permissions`;

  for (let i = 0; i < nextLen; i++) {
    const p = prev.steps[i];
    const n = next.steps[i];
    if (!p || !n) continue;
    const change = describePromptChange(
      `prompt ${i + 1}`,
      p as PromptChangeFields,
      n as PromptChangeFields
    );
    if (change) return change;
  }

  return "Changed workflow";
}

export const UndoRedoControl: React.FC<UndoRedoControlProps> = ({
  isRunning,
  isPaused,
  embedded = false,
  showHistoryChevronOnDesktopOnly = "sm",
  onAction,
}) => {
  const vscode = useVsCodeApi();
  const isMobile = useIsMobile();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupPos, setPopupPos] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  } | null>(null);

  const getPopupPosition = useCallback(() => {
    if (!containerRef.current) {
      return null;
    }

    const rect = containerRef.current.getBoundingClientRect();
    return {
      top: rect.bottom + 4,
      left: rect.left,
      maxHeight: Math.max(window.innerHeight - rect.bottom - 8, 120),
    };
  }, []);

  const canUndo = useWorkflowTemporalStore((s) => s.pastStates.length > 0);
  const canRedo = useWorkflowTemporalStore((s) => s.futureStates.length > 0);
  const pastStates = useWorkflowTemporalStore((s) => s.pastStates);
  const futureStates = useWorkflowTemporalStore((s) => s.futureStates);

  const editingDisabled = isRunning || isPaused;

  useEffect(() => {
    if (isMobile && isOpen) {
      setIsOpen(false);
    }
  }, [isMobile, isOpen]);

  useEffect(() => {
    if (isOpen) {
      const updatePosition = () => {
        setPopupPos(getPopupPosition());
      };
      updatePosition();
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, true);
      return () => {
        window.removeEventListener("resize", updatePosition);
        window.removeEventListener("scroll", updatePosition, true);
      };
    }
    setPopupPos(null);
  }, [getPopupPosition, isOpen]);

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
    postWorkflowDefinitionMutation(vscode, {
      type: MESSAGE_TYPES.UNDO_REDO_SYNC,
      steps: ws.steps,
      finalStep: ws.finalStep,
      workflowProperties,
      // workflowName is zundo-tracked (partialize/equality/describeChange all
      // cover it) so Undo/Redo shows it as restorable, but nothing previously
      // sent the reverted name back to the server — the persisted definition
      // never actually changed, so the next resync silently overwrote the
      // local revert back to the un-reverted name.
      workflowName: ws.workflowName,
    });
  }, [vscode]);

  const normalizeAfterHistoryAction = useCallback(
    (previousState: {
      steps: WorkflowStep[];
      finalStep: WorkflowStep | null;
    }) => {
      useWorkflowStore.temporal.getState().pause();
      useWorkflowStore.setState((state) => {
        const reconciledSteps = mergeRuntimeForUndoRedo(
          state.steps,
          previousState.steps
        );
        const reconciledFinalStep = state.finalStep
          ? reconcileStepRuntime(
              state.finalStep,
              previousState.finalStep ?? undefined
            )
          : null;

        return {
          steps: reconciledSteps,
          finalStep: reconciledFinalStep,
          currentStep: Math.min(
            deriveCurrentStep(reconciledSteps),
            reconciledSteps.length
          ),
          totalSteps: reconciledSteps.length,
        };
      });
      useWorkflowStore.temporal.getState().resume();
    },
    []
  );

  const handleUndo = useCallback(() => {
    if (!canUndo || editingDisabled) return;
    const previousState = {
      steps: useWorkflowStore.getState().steps,
      finalStep: useWorkflowStore.getState().finalStep,
    };
    rememberUndoRedoRuntime(previousState.steps);
    useWorkflowStore.temporal.getState().undo();
    normalizeAfterHistoryAction(previousState);
    syncToVsCode();
  }, [canUndo, editingDisabled, normalizeAfterHistoryAction, syncToVsCode]);

  const handleRedo = useCallback(() => {
    if (!canRedo || editingDisabled) return;
    const previousState = {
      steps: useWorkflowStore.getState().steps,
      finalStep: useWorkflowStore.getState().finalStep,
    };
    rememberUndoRedoRuntime(previousState.steps);
    useWorkflowStore.temporal.getState().redo();
    normalizeAfterHistoryAction(previousState);
    syncToVsCode();
  }, [canRedo, editingDisabled, normalizeAfterHistoryAction, syncToVsCode]);

  const handleJumpTo = useCallback(
    (stepCount: number, direction: "undo" | "redo") => {
      if (editingDisabled) return;
      const previousState = {
        steps: useWorkflowStore.getState().steps,
        finalStep: useWorkflowStore.getState().finalStep,
      };
      rememberUndoRedoRuntime(previousState.steps);
      const temporal = useWorkflowStore.temporal.getState();
      for (let i = 0; i < stepCount; i++) {
        if (direction === "redo") {
          temporal.redo();
        } else {
          temporal.undo();
        }
      }
      normalizeAfterHistoryAction(previousState);
      syncToVsCode();
      setIsOpen(false);
    },
    [editingDisabled, normalizeAfterHistoryAction, syncToVsCode]
  );

  // Build history list: most-recent first.
  // pastStates[length-1] = one undo away; pastStates[0] = furthest back.
  // The label for entry di describes what changed FROM that past state TO the
  // state that followed it (either another past state or the current state).
  const historyEntries = React.useMemo(() => {
    const s = useWorkflowStore.getState();
    const current: UndoableWorkflowState = {
      steps: s.steps ?? [],
      workflowName: s.workflowName ?? null,
      finalStep: s.finalStep ?? null,
      undoWorkflowProperties: s.undoWorkflowProperties ?? {},
      runtimeUndoGeneration: s.runtimeUndoGeneration ?? 0,
    };
    // futureStates[0] = oldest future (last to redo), futureStates[length-1] = most recently undone (first to redo)
    // Display oldest-future first (top) so the most steps appear at the top, matching undo ordering.
    const typedFuture = futureStates as UndoableWorkflowState[];
    const undoStates = ([...pastStates] as UndoableWorkflowState[]).reverse();

    const redoEntries = typedFuture.map((state, i) => {
      // prevState is the state that was current just before this future state was recorded
      const prevState =
        i === typedFuture.length - 1 ? current : typedFuture[i + 1];
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

  const btnSizes = isMobile
    ? HEADER_BUTTON_SIZES.touch
    : HEADER_BUTTON_SIZES.default;
  const btnBase = `inline-flex items-center justify-center h-full min-w-[calc(var(--fp-touch-target)-2px)] px-2 text-sm transition-colors focus:outline-none focus-visible:ring-1`;
  const btnBaseDesktop =
    "inline-flex h-full self-stretch items-center justify-center min-w-[28px] px-2 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-1";
  const resolvedBtnBase = isMobile ? btnBase : btnBaseDesktop;
  const activeClass =
    "bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover";
  const disabledClass =
    "bg-btn-secondary-bg text-btn-secondary-fg opacity-50 cursor-not-allowed";
  const separatorClass = `bg-btn-secondary-bg text-btn-secondary-fg ${btnSizes.separatorPy} flex-shrink-0`;
  const containerClass = embedded
    ? `relative inline-flex h-full self-stretch overflow-hidden flex-shrink-0 ${btnSizes.groupContainer}`
    : `fp-button-group ${btnSizes.groupContainer}`;

  const undoDisabled = !canUndo || editingDisabled;
  const redoDisabled = !canRedo || editingDisabled;
  const chevronDisabled = historyEntries.length === 0 || editingDisabled;
  const historyChevronVisibilityClass =
    showHistoryChevronOnDesktopOnly === "lg"
      ? "hidden lg:flex"
      : "hidden sm:flex";

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
      className={containerClass}
      role="group"
      aria-label="Undo / Redo"
    >
      <button
        type="button"
        className={`${resolvedBtnBase} ${undoDisabled ? disabledClass : activeClass}`}
        onClick={() => {
          onAction?.("undo-click", getDebugDetails());
          handleUndo();
        }}
        disabled={undoDisabled}
        title="Undo"
        aria-label="Undo"
      >
        <i className={`codicon codicon-discard ${btnSizes.icon}`} />
      </button>

      <div className={separatorClass}>
        <div className="w-px h-full bg-current opacity-40" />
      </div>

      <button
        type="button"
        className={`${resolvedBtnBase} ${redoDisabled ? disabledClass : activeClass}`}
        onClick={() => {
          onAction?.("redo-click", getDebugDetails());
          handleRedo();
        }}
        disabled={redoDisabled}
        title="Redo"
        aria-label="Redo"
      >
        <i className={`codicon codicon-redo ${btnSizes.icon}`} />
      </button>

      {!isMobile && (
        <>
          {/* Separator */}
          <div className={`${separatorClass} ${historyChevronVisibilityClass}`}>
            <div className="w-px h-full bg-current opacity-40" />
          </div>

          {/* History chevron */}
          <button
            type="button"
            className={`${resolvedBtnBase} ${historyChevronVisibilityClass} px-1.5 ${chevronDisabled ? disabledClass : activeClass} ${isOpen ? "bg-btn-secondary-hover" : ""}`}
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
        </>
      )}

      {/* Dropdown */}
      {isOpen &&
        historyEntries.length > 0 &&
        popupPos &&
        createPortal(
          <div
            ref={popupRef}
            role="listbox"
            className="fixed min-w-[220px] overflow-y-auto bg-dropdown-bg border border-dropdown-border rounded shadow-lg z-popover"
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
                aria-selected={false}
                onClick={() => {
                  onAction?.(
                    "history-jump",
                    getDebugDetails({ stepCount, direction, isOpen: false })
                  );
                  handleJumpTo(stepCount, direction);
                }}
                className={`fp-dropdown-row w-full text-left px-3 py-1.5 text-sm hover:bg-list-hover-bg hover:text-list-highlight-fg cursor-pointer flex items-center gap-2 ${
                  direction === "redo"
                    ? "text-dropdown-fg opacity-80"
                    : "text-dropdown-fg"
                }`}
              >
                <i
                  className={`codicon ${
                    direction === "redo" ? "codicon-redo" : "codicon-discard"
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
