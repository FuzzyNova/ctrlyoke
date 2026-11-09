import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  IN_FLIGHT_EXECUTION_STATES,
  STEP_STATUS,
  type ExecutionState,
  type FinalStepPhase,
  type PromptTerminalStatus,
  type StepStatus,
} from "../types/DashboardConstants";

/**
 * Whether the queue position at `currentIndex` belongs to an executing step.
 * A running final step sits after the queue, so steps appended at that
 * position have not started until execution returns to the queue phase.
 */
export function hasInFlightStep(
  executionState: ExecutionState | undefined,
  finalStepPhase: FinalStepPhase | undefined
): boolean {
  return (
    executionState !== undefined &&
    IN_FLIGHT_EXECUTION_STATES.has(executionState) &&
    finalStepPhase !== FINAL_STEP_PHASES.FINAL_STEP
  );
}

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
    terminalFailure?: boolean;
    rewoundFailure?: boolean;
  };
}

/** Queue index whose attempt history must remain attached to the failed step. */
export function getProtectedTerminalFailureIndex(state: {
  executionState: string | undefined;
  currentIndex: number | undefined;
  steps: readonly StepWithRuntimeStatus[];
  resultStatus?: string;
}): number | undefined {
  const terminalIndex = getResumableTerminalFailureIndex(state);
  if (terminalIndex !== undefined) return terminalIndex;
  const index = state.currentIndex ?? -1;
  return state.executionState === EXECUTION_STATES.ERROR &&
    index >= 0 &&
    state.steps[index]?._runtime?.rewoundFailure === true
    ? index
    : undefined;
}

/** Queue index of the failed step that continuation will run again. */
export function getResumableTerminalFailureIndex(state: {
  executionState: string | undefined;
  currentIndex: number | undefined;
  steps: readonly (StepWithRuntimeStatus & {
    _runtime?: StepWithRuntimeStatus["_runtime"] & {
      terminalFailure?: boolean;
    };
  })[];
  resultStatus?: string;
}): number | undefined {
  const index = (state.currentIndex ?? 0) - 1;
  const step = state.steps[index];
  return state.executionState === EXECUTION_STATES.ERROR &&
    (state.resultStatus === undefined ||
      state.resultStatus === STEP_STATUS.FAILED) &&
    index >= 0 &&
    step?._runtime?.terminalStatus === STEP_STATUS.FAILED &&
    step._runtime.terminalFailure !== false
    ? index
    : undefined;
}

/** The bounds of a parallel group, as far as failure recovery reads them. */
export interface ParallelGroupBounds {
  startIndex: number;
  endIndex: number;
}

/**
 * The parallel group whose terminal member failure ended a settled ERROR run.
 * A group's join moves the head past the whole group, so the step just before
 * the head can be a member that succeeded; continuation must go back to the
 * group's start rather than to that one step.
 */
export function getResumableTerminalFailedGroup<
  G extends ParallelGroupBounds,
>(state: {
  executionState: string | undefined;
  currentIndex: number | undefined;
  steps: readonly StepWithRuntimeStatus[];
  parallelGroups: readonly G[] | undefined;
}): G | undefined {
  if (state.executionState !== EXECUTION_STATES.ERROR) return undefined;
  const lastIndex = (state.currentIndex ?? 0) - 1;
  const group = state.parallelGroups?.find(
    (candidate) => candidate.endIndex === lastIndex
  );
  if (!group) return undefined;
  const failed = state.steps
    .slice(group.startIndex, group.endIndex + 1)
    .some(
      (step) =>
        step?._runtime?.terminalStatus === STEP_STATUS.FAILED &&
        step._runtime.terminalFailure !== false
    );
  return failed ? group : undefined;
}

/**
 * Whether a member runs again when its failed group is retried: every member
 * that did not succeed (failed, cancelled when a sibling stopped the run, or
 * never settled). Completed, skipped and no-turn members stay settled.
 */
export function isGroupMemberRetried(
  step: StepWithRuntimeStatus | undefined
): boolean {
  const status = step?._runtime?.terminalStatus;
  return (
    step?._runtime?.completedAt === undefined ||
    status === STEP_STATUS.FAILED ||
    status === STEP_STATUS.CANCELLED
  );
}

export function terminalFailureMutationMessage(
  action: "remove" | "reorder"
): string {
  const operation = action === "remove" ? "remove" : "move";
  const suggestion =
    action === "remove"
      ? "disable it to skip it on continue"
      : "edit or disable it instead";
  return `Cannot ${operation} the failed step because it has recorded history and must stay first among pending steps; ${suggestion}.`;
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
  inFlightStatus: StepStatus = STEP_STATUS.RUNNING,
  finalStepPhase?: FinalStepPhase
): StepStatus[] {
  return steps.map((step, index) => {
    const stepRuntime = step._runtime;
    if (stepRuntime?.completedAt !== undefined) {
      return stepRuntime.terminalStatus ?? STEP_STATUS.COMPLETED;
    }
    if (!IN_FLIGHT_EXECUTION_STATES.has(executionState as ExecutionState)) {
      return STEP_STATUS.PENDING;
    }
    if (
      stepRuntime?.startedAt !== undefined ||
      (index === currentIndex &&
        hasInFlightStep(
          executionState as ExecutionState | undefined,
          finalStepPhase
        ))
    ) {
      return inFlightStatus;
    }
    return STEP_STATUS.PENDING;
  });
}
