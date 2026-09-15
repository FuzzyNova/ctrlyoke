import {
  EXECUTION_STATES,
  STEP_STATUS,
  type PromptTerminalStatus,
  type StepStatus,
} from "../types/DashboardConstants";

/**
 * The only part of a step this derivation reads. Kept structurally minimal so
 * both the extension host (`WorkflowStep`) and the webview (the raw parsed
 * working-file JSON of a `RUN_VIEW_LOADED` snapshot) can pass their own shape
 * without a cast.
 */
export interface StepWithRuntimeStatus {
  _runtime?: {
    completedAt?: number;
    terminalStatus?: PromptTerminalStatus;
  };
}

/**
 * Derive each step's display status from its **own** persisted `_runtime`,
 * never from its position relative to `currentIndex`.
 *
 * `PromptQueue.commitStepOutcomeAndAdvance` advances `currentIndex` past a step
 * even when that step's outcome is a terminal failure that stops the workflow,
 * so a positional rule ("i < currentIndex → completed") mislabels the step that
 * actually failed as COMPLETED. That in turn fools the dashboard's
 * `usePromptStatus` stale-failure guard — which only suppresses painting the
 * error badge on `currentIndex` when the *previous* step's recorded status is
 * already FAILED — into painting the error badge on the next, never-executed
 * step instead.
 *
 * `inFlightStatus` exists because the two call sites paint the in-flight step
 * differently: the live external-run push reports it as RUNNING, while the
 * addressed run-view snapshot reports it as SENT.
 */
export function deriveStepStatusesFromRuntime(
  steps: readonly StepWithRuntimeStatus[],
  currentIndex: number,
  executionState: string | undefined,
  inFlightStatus: StepStatus = STEP_STATUS.RUNNING
): StepStatus[] {
  return steps.map((step, index) => {
    const stepRuntime = step._runtime;
    if (stepRuntime?.completedAt !== undefined) {
      return stepRuntime.terminalStatus ?? STEP_STATUS.COMPLETED;
    }
    if (index === currentIndex && executionState === EXECUTION_STATES.RUNNING) {
      return inFlightStatus;
    }
    return STEP_STATUS.PENDING;
  });
}
