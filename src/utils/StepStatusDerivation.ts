import {
  EXECUTION_STATES,
  IN_FLIGHT_EXECUTION_STATES,
  STEP_STATUS,
  type ExecutionState,
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
    /** Identity only — never evidence of execution (see `hasStarted`). */
    stepId?: string;
    startedAt?: number;
    completedAt?: number;
    terminalStatus?: PromptTerminalStatus;
  };
}

/**
 * A step has entered execution once dispatch claimed it (`startedAt`) or it
 * reached a terminal state (`completedAt`, which a skip also sets). The mere
 * presence of `_runtime` is not evidence: it also carries the step's identity
 * (`stepId`), which every persisted step has — including every step of a
 * freshly seeded, never-executed run.
 */
export function hasStarted(step: StepWithRuntimeStatus | undefined): boolean {
  return (
    step?._runtime?.startedAt !== undefined ||
    step?._runtime?.completedAt !== undefined
  );
}

/**
 * The runtime facts that decide whether a run has executed anything. A plain
 * shape so the extension host can pass a run's working file and the webview
 * its store state.
 */
export interface RunStartState {
  executionState: string | undefined;
  currentIndex: number | undefined;
  finalStepStatus: string | null | undefined;
  steps: readonly StepWithRuntimeStatus[];
}

/**
 * A run is unstarted when it sits IDLE on step 0 and neither a queue step nor
 * the final step has any execution evidence — the state `seedNewRun` leaves a
 * run in when it is prepared without being executed ("New Run (Don't Start)",
 * or "Set start position" on the first step). Its natural next action is Run,
 * and preparing another run from it should reopen it rather than mint a copy.
 */
export function isUnstartedRun(state: RunStartState): boolean {
  return (
    (state.executionState ?? EXECUTION_STATES.IDLE) === EXECUTION_STATES.IDLE &&
    (state.currentIndex ?? 0) === 0 &&
    (state.finalStepStatus ?? null) === null &&
    !state.steps.some(hasStarted)
  );
}

/** `isUnstartedRun` for a persisted run working file. */
export function isUnstartedRunFile(workingFile: {
  steps?: readonly StepWithRuntimeStatus[];
  _runtime?: {
    executionState?: string;
    currentIndex?: number;
    finalStep?: { status?: string };
  };
}): boolean {
  return isUnstartedRun({
    executionState: workingFile._runtime?.executionState,
    currentIndex: workingFile._runtime?.currentIndex,
    finalStepStatus: workingFile._runtime?.finalStep?.status,
    steps: workingFile.steps ?? [],
  });
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
 *
 * `startedAt` is the executor's dispatch claim, so it — not `currentIndex` —
 * is what identifies an in-flight step. During a parallel group `currentIndex`
 * stays pinned at the group's `startIndex` until the join, so every member
 * after the first would otherwise read as PENDING while a worker is executing
 * it.
 *
 * A step is only painted in flight while the run is in an
 * `IN_FLIGHT_EXECUTION_STATES` state. Pause lets the current step finish, so
 * a PAUSING run still has that step executing. Once PAUSED, the step has
 * settled with `completedAt` and the next step is PENDING.
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
    if (!IN_FLIGHT_EXECUTION_STATES.has(executionState as ExecutionState)) {
      return STEP_STATUS.PENDING;
    }
    if (stepRuntime?.startedAt !== undefined || index === currentIndex) {
      return inFlightStatus;
    }
    return STEP_STATUS.PENDING;
  });
}
