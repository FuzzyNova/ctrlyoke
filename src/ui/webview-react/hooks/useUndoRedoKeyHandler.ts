import { useEffect } from "react";
import { useWorkflowStore, type WorkflowStep } from "../store/workflowStore";
import { useSettingsStore } from "../store/settingsStore";
import { WebviewLog } from "@utils/logger";
import {
  MESSAGE_TYPES,
  PROMPT_TERMINAL_STATUS,
  STEP_STATUS,
  type StepStatus,
} from "../types/messages";
import { getVsCodeApi } from "./useVsCodeApi";
import { postWorkflowDefinitionMutation } from "../utils/workflowMutation";

type RuntimeDecoratedStep = WorkflowStep & {
  status?: StepStatus;
  details?: unknown;
};

type RuntimeSnapshot = {
  status?: StepStatus;
  _runtime?: RuntimeDecoratedStep["_runtime"];
  details?: unknown;
};

const undoRedoRuntimeCache = new Map<string, RuntimeSnapshot>();

function stepText(step: WorkflowStep): string {
  return "script" in step && typeof step.script === "string"
    ? step.script
    : "prompt" in step && typeof step.prompt === "string"
      ? step.prompt
      : "";
}

function runtimeCacheKeys(step: WorkflowStep, index: number): string[] {
  const type = "type" in step && step.type ? step.type : "prompt";
  const name = "name" in step && step.name ? step.name : "";
  const text = stepText(step);
  return [
    `${index}\u0000${type}\u0000${name}\u0000${text}`,
    `${type}\u0000${name}\u0000${text}`,
  ];
}

function getRuntimeSnapshot(step: WorkflowStep): RuntimeSnapshot | undefined {
  const decorated = step as RuntimeDecoratedStep;
  const snapshot: RuntimeSnapshot = {};
  if (decorated.status !== undefined) {
    snapshot.status = decorated.status;
  }
  if (decorated._runtime !== undefined) {
    snapshot._runtime = decorated._runtime;
  }
  if (decorated.details !== undefined) {
    snapshot.details = decorated.details;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

export function rememberUndoRedoRuntime(steps: WorkflowStep[]): void {
  steps.forEach((step, index) => {
    const snapshot = getRuntimeSnapshot(step);
    if (!snapshot) return;
    for (const key of runtimeCacheKeys(step, index)) {
      undoRedoRuntimeCache.set(key, snapshot);
    }
  });
}

function findCachedRuntime(
  step: WorkflowStep,
  index: number
): RuntimeSnapshot | undefined {
  for (const key of runtimeCacheKeys(step, index)) {
    const snapshot = undoRedoRuntimeCache.get(key);
    if (snapshot) return snapshot;
  }
  return undefined;
}

function isTerminalStatus(status: StepStatus | undefined): boolean {
  return (
    status === STEP_STATUS.COMPLETED ||
    status === STEP_STATUS.FAILED ||
    status === STEP_STATUS.CANCELLED ||
    status === STEP_STATUS.SKIPPED
  );
}

function deriveCurrentStepFromRuntime(steps: WorkflowStep[]): number {
  const firstPendingIndex = steps.findIndex((step) => {
    const decorated = step as RuntimeDecoratedStep;
    return (
      decorated._runtime?.completedAt === undefined &&
      !isTerminalStatus(decorated.status)
    );
  });
  return firstPendingIndex === -1 ? steps.length : firstPendingIndex;
}

function deriveStatusFromRuntime(
  runtime: RuntimeDecoratedStep["_runtime"] | undefined,
  fallback: StepStatus | undefined
): StepStatus | undefined {
  if (runtime?.completedAt === undefined) {
    return fallback;
  }

  const terminalStatus =
    "terminalStatus" in runtime ? runtime.terminalStatus : undefined;

  return terminalStatus === PROMPT_TERMINAL_STATUS.CANCELLED
    ? STEP_STATUS.CANCELLED
    : terminalStatus === PROMPT_TERMINAL_STATUS.FAILED
      ? STEP_STATUS.FAILED
      : STEP_STATUS.COMPLETED;
}

export function mergeRuntimeForUndoRedo(
  restoredSteps: WorkflowStep[],
  liveSteps: WorkflowStep[]
): WorkflowStep[] {
  const merged = restoredSteps.map((step, index) => {
    const live = liveSteps[index] as RuntimeDecoratedStep | undefined;
    const restored = step as RuntimeDecoratedStep;
    const cached = findCachedRuntime(step, index);

    const runtime = restored._runtime ?? cached?._runtime ?? live?._runtime;
    // Only trust restored.status if it is terminal. Snapshots may store a stale
    // "pending" status written by loadWorkflow/EXECUTION_STARTED before the step
    // ran. A non-terminal restored status must never override a live/cached
    // "completed" status from a run that happened after the snapshot was taken.
    const restoredStatus = isTerminalStatus(restored.status)
      ? restored.status
      : undefined;
    const status = deriveStatusFromRuntime(
      runtime,
      restoredStatus ?? cached?.status ?? live?.status
    );
    const details = restored.details ?? cached?.details ?? live?.details;

    return {
      ...restored,
      ...(status !== undefined ? { status } : {}),
      ...(runtime !== undefined ? { _runtime: runtime } : {}),
      ...(details !== undefined ? { details } : {}),
    } as WorkflowStep;
  });

  rememberUndoRedoRuntime(merged);
  return merged;
}

export function clearUndoRedoRuntimeCacheForTests(): void {
  undoRedoRuntimeCache.clear();
}

export function useUndoRedoKeyHandler() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only log undo/redo-related keys to avoid spam
      const mightBeUndoRedo =
        (e.ctrlKey || e.metaKey) &&
        (e.key === "z" || e.key === "y" || e.key === "Z");
      if (!mightBeUndoRedo) return;

      // Don't intercept if a text input or CodeMirror editor is focused —
      // let the focused element handle its own undo/redo.
      const target = e.target as HTMLElement;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.closest(".cm-editor") !== null;

      const isUndo = (e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey;
      const isRedo =
        (e.ctrlKey || e.metaKey) &&
        (e.key === "y" || (e.key === "z" && e.shiftKey));

      const temporal = useWorkflowStore.temporal.getState();
      WebviewLog.debug(
        `[UndoRedo] keydown: key=${e.key} ctrl=${e.ctrlKey} meta=${e.metaKey} shift=${e.shiftKey} ` +
          `isUndo=${isUndo} isRedo=${isRedo} isTextInput=${isTextInput} ` +
          `target=${target.tagName}.${target.className?.slice?.(0, 30)} ` +
          `pastStates=${temporal.pastStates.length} futureStates=${temporal.futureStates.length}`
      );

      if (isTextInput) return;

      if (!isUndo && !isRedo) return;

      // Don't undo/redo while a workflow is active (running or paused)
      const isActive = useWorkflowStore.getState().isWorkflowActive();
      if (isActive) {
        WebviewLog.debug(`[UndoRedo] blocked — workflow isActive=${isActive}`);
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      WebviewLog.debug(
        `[UndoRedo] ${isUndo ? "undo" : "redo"} — pastStates=${temporal.pastStates.length} futureStates=${temporal.futureStates.length}`
      );

      // Capture live runtime state before applying undo/redo. The zundo equality
      // guard prevents snapshots from recording runtime-only changes, but the
      // snapshot content may still lack current _runtime/status/details (e.g. when
      // a snapshot was taken before the step was run). Re-attaching them keeps the
      // UI consistent and ensures the server message includes the current session IDs.
      const preUndoSteps = useWorkflowStore.getState().steps;
      rememberUndoRedoRuntime(preUndoSteps);

      if (isUndo) temporal.undo();
      else temporal.redo();

      const after = useWorkflowStore.temporal.getState();
      WebviewLog.debug(
        `[UndoRedo] after ${isUndo ? "undo" : "redo"} — pastStates=${after.pastStates.length} futureStates=${after.futureStates.length}`
      );

      // Merge live _runtime/status/details back into the restored steps so the UI
      // doesn't flash to "pending" for already-completed steps and the server
      // receives complete step data (including session IDs for resume).
      const ws = useWorkflowStore.getState();
      const mergedSteps = mergeRuntimeForUndoRedo(ws.steps, preUndoSteps);
      // Apply merged runtime state without creating a new undo entry.
      useWorkflowStore.temporal.getState().pause();
      useWorkflowStore.setState({
        steps: mergedSteps,
        currentStep: deriveCurrentStepFromRuntime(mergedSteps),
        totalSteps: mergedSteps.length,
      });
      useWorkflowStore.temporal.getState().resume();

      const workflowProperties = ws.undoWorkflowProperties;
      // Sync workflowProperties back to settingsStore so UI reflects the restored state
      useSettingsStore.getState().setWorkflowProperties(workflowProperties);
      postWorkflowDefinitionMutation(getVsCodeApi(), {
        type: MESSAGE_TYPES.UNDO_REDO_SYNC,
        steps: mergedSteps,
        parallelGroups: ws.parallelGroups,
        finalStep: ws.finalStep,
        workflowProperties,
      });
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);
}
