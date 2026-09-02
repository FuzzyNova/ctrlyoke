import { EXECUTION_STATES } from "../types/CtrlYokeTypes";
import {
  FINAL_STEP_PHASES,
  WORKFLOW_ATTEMPT_COMMANDS,
  WORKFLOW_ATTEMPT_STATUS,
  WORKFLOW_RUNTIME_COMMANDS,
  type ExecutionState,
} from "../types/DashboardConstants";
import type {
  WorkflowAttemptCommand,
  WorkflowAttemptState,
  WorkflowAttemptTarget,
  WorkflowAttemptTransition,
  WorkflowRuntimeCommand,
  WorkflowRuntimeState,
  WorkflowRuntimeTransition,
} from "../types/CtrlYokeTypes";
import { TypedEmitter } from "../utils/TypedEmitter";

/**
 * WorkflowStateMachine
 *
 * RESPONSIBILITY: Sole owner of workflow execution status transitions.
 *
 * Owns the runtime status fields that represent how execution is progressing:
 *   - status:               current execution state
 *   - stopped:              true if stop() was requested; cleared on resume or new start
 *   - startTime:            when the execution timer was started
 *   - pausedTime:           when the current pause began (cleared on resume)
 *   - totalPausedDuration:  accumulated pause time across the run (milliseconds)
 *   - executionEndTime:     terminal timestamp that freezes active execution time
 *
 * PromptQueue delegates all status transitions here. Queue topology concerns
 * (currentIndex, prompts, results, completedIndices) remain in PromptQueue.
 *
 * Phase 2 of the Better Code Initiative 1: Introduce Authoritative Runtime State Machine.
 * See dev/backlog/BETTER_CODE_INITIATIVE_1.md for the full design.
 */
export class WorkflowStateMachine {
  private _status: ExecutionState = EXECUTION_STATES.IDLE;
  private _stopped: boolean = false;
  private _startTime: number | undefined = undefined;
  private _pausedTime: number | undefined = undefined;
  private _totalPausedDuration: number = 0;
  private _executionEndTime: number | undefined = undefined;
  private readonly onTransitionEmitter =
    new TypedEmitter<WorkflowRuntimeTransition>();
  private readonly onAttemptTransitionEmitter =
    new TypedEmitter<WorkflowAttemptTransition>();
  private readonly attempts = new Map<string, WorkflowAttemptState>();
  private activeAttemptKey: string | undefined;

  public readonly onDidTransition = this.onTransitionEmitter.event;
  public readonly onDidAttemptTransition =
    this.onAttemptTransitionEmitter.event;

  // ─── Getters ─────────────────────────────────────────────────────────────────

  get status(): ExecutionState {
    return this._status;
  }

  get stopped(): boolean {
    return this._stopped;
  }

  get startTime(): number | undefined {
    return this._startTime;
  }

  get pausedTime(): number | undefined {
    return this._pausedTime;
  }

  get totalPausedDuration(): number {
    return this._totalPausedDuration;
  }

  getSnapshot(): WorkflowRuntimeState {
    return {
      status: this._status,
      stopped: this._stopped,
      startTime: this._startTime,
      pausedTime: this._pausedTime,
      totalPausedDuration: this._totalPausedDuration,
      executionEndTime: this._executionEndTime,
    };
  }

  getAttempt(target: WorkflowAttemptTarget): WorkflowAttemptState | undefined {
    return this.cloneAttemptState(
      this.attempts.get(this.getAttemptKey(target))
    );
  }

  getActiveAttempt(): WorkflowAttemptState | undefined {
    return this.activeAttemptKey
      ? this.cloneAttemptState(this.attempts.get(this.activeAttemptKey))
      : undefined;
  }

  private getAttemptKey(target: WorkflowAttemptTarget): string {
    return target.kind === FINAL_STEP_PHASES.QUEUE
      ? `queue:${target.stepIndex}`
      : `final:${target.loopIndex}`;
  }

  private cloneAttemptState(
    state: WorkflowAttemptState | undefined
  ): WorkflowAttemptState | undefined {
    if (!state) {
      return undefined;
    }

    return {
      ...state,
      target: { ...state.target },
    };
  }

  private emitTransition(
    command: WorkflowRuntimeCommand,
    previous: WorkflowRuntimeState,
    timestampMs: number = Date.now()
  ): void {
    this.onTransitionEmitter.fire({
      command,
      previous,
      current: this.getSnapshot(),
      timestampMs,
    });
  }

  private emitAttemptTransition(
    command: WorkflowAttemptCommand,
    current: WorkflowAttemptState,
    previous: WorkflowAttemptState | undefined,
    timestampMs: number
  ): void {
    this.onAttemptTransitionEmitter.fire({
      command,
      previous,
      current,
      timestampMs,
    });
  }

  beginAttempt(
    target: WorkflowAttemptTarget,
    attemptIndex: number,
    timestampMs: number = Date.now()
  ): WorkflowAttemptState {
    const key = this.getAttemptKey(target);
    const previous = this.cloneAttemptState(this.attempts.get(key));
    const current: WorkflowAttemptState = {
      target: { ...target },
      attemptIndex,
      status: WORKFLOW_ATTEMPT_STATUS.RUNNING,
      startedAt: timestampMs,
      retryCount:
        previous?.attemptIndex === attemptIndex
          ? previous.retryCount
          : undefined,
      maxRetries:
        previous?.attemptIndex === attemptIndex
          ? previous.maxRetries
          : undefined,
    };

    this.attempts.set(key, current);
    this.activeAttemptKey = key;
    this.emitAttemptTransition(
      WORKFLOW_ATTEMPT_COMMANDS.BEGIN,
      this.cloneAttemptState(current)!,
      previous,
      timestampMs
    );
    return this.cloneAttemptState(current)!;
  }

  /**
   * Stamp the moment this attempt's prompt phase begins. The attempt itself
   * starts earlier (it spans the pre-condition gate), so output produced by
   * the prompt must be timestamped from here — see `WorkflowAttemptState`.
   * Returns the effective prompt-phase start, so callers can use the return
   * value directly without a second read.
   */
  markPromptStarted(
    target: WorkflowAttemptTarget,
    timestampMs: number = Date.now()
  ): number {
    const existing = this.attempts.get(this.getAttemptKey(target));
    if (!existing) {
      return timestampMs;
    }

    existing.promptStartedAt = timestampMs;
    return timestampMs;
  }

  scheduleRetry(
    target: WorkflowAttemptTarget,
    attemptIndex: number,
    retryCount: number,
    maxRetries: number,
    timestampMs: number = Date.now()
  ): WorkflowAttemptState {
    const key = this.getAttemptKey(target);
    const previous = this.cloneAttemptState(this.attempts.get(key));
    const current: WorkflowAttemptState = {
      target: { ...target },
      attemptIndex,
      status: WORKFLOW_ATTEMPT_STATUS.RETRYING,
      startedAt: timestampMs,
      retryCount,
      maxRetries,
    };

    this.attempts.set(key, current);
    if (this.activeAttemptKey === key) {
      this.activeAttemptKey = undefined;
    }
    this.emitAttemptTransition(
      WORKFLOW_ATTEMPT_COMMANDS.SCHEDULE_RETRY,
      this.cloneAttemptState(current)!,
      previous,
      timestampMs
    );
    return this.cloneAttemptState(current)!;
  }

  completeAttempt(
    target: WorkflowAttemptTarget,
    attemptIndex: number,
    timestampMs: number = Date.now()
  ): WorkflowAttemptState {
    const key = this.getAttemptKey(target);
    const previous = this.cloneAttemptState(this.attempts.get(key));
    const current: WorkflowAttemptState = {
      target: { ...target },
      attemptIndex,
      status: WORKFLOW_ATTEMPT_STATUS.COMPLETED,
      startedAt:
        previous?.attemptIndex === attemptIndex
          ? previous.startedAt
          : timestampMs,
      promptStartedAt:
        previous?.attemptIndex === attemptIndex
          ? previous.promptStartedAt
          : undefined,
      completedAt: timestampMs,
      retryCount:
        previous?.attemptIndex === attemptIndex
          ? previous.retryCount
          : undefined,
      maxRetries:
        previous?.attemptIndex === attemptIndex
          ? previous.maxRetries
          : undefined,
    };

    this.attempts.set(key, current);
    if (this.activeAttemptKey === key) {
      this.activeAttemptKey = undefined;
    }
    this.emitAttemptTransition(
      WORKFLOW_ATTEMPT_COMMANDS.COMPLETE,
      this.cloneAttemptState(current)!,
      previous,
      timestampMs
    );
    return this.cloneAttemptState(current)!;
  }

  failAttempt(
    target: WorkflowAttemptTarget,
    attemptIndex: number,
    failureReason: string,
    timestampMs: number = Date.now()
  ): WorkflowAttemptState {
    const key = this.getAttemptKey(target);
    const previous = this.cloneAttemptState(this.attempts.get(key));
    const current: WorkflowAttemptState = {
      target: { ...target },
      attemptIndex,
      status: WORKFLOW_ATTEMPT_STATUS.FAILED,
      startedAt:
        previous?.attemptIndex === attemptIndex
          ? previous.startedAt
          : timestampMs,
      promptStartedAt:
        previous?.attemptIndex === attemptIndex
          ? previous.promptStartedAt
          : undefined,
      completedAt: timestampMs,
      retryCount:
        previous?.attemptIndex === attemptIndex
          ? previous.retryCount
          : undefined,
      maxRetries:
        previous?.attemptIndex === attemptIndex
          ? previous.maxRetries
          : undefined,
      failureReason,
    };

    this.attempts.set(key, current);
    if (this.activeAttemptKey === key) {
      this.activeAttemptKey = undefined;
    }
    this.emitAttemptTransition(
      WORKFLOW_ATTEMPT_COMMANDS.FAIL,
      this.cloneAttemptState(current)!,
      previous,
      timestampMs
    );
    return this.cloneAttemptState(current)!;
  }

  cancelAttempt(
    target: WorkflowAttemptTarget,
    attemptIndex: number,
    failureReason?: string,
    timestampMs: number = Date.now()
  ): WorkflowAttemptState {
    const key = this.getAttemptKey(target);
    const previous = this.cloneAttemptState(this.attempts.get(key));
    const current: WorkflowAttemptState = {
      target: { ...target },
      attemptIndex,
      status: WORKFLOW_ATTEMPT_STATUS.CANCELLED,
      startedAt:
        previous?.attemptIndex === attemptIndex
          ? previous.startedAt
          : timestampMs,
      promptStartedAt:
        previous?.attemptIndex === attemptIndex
          ? previous.promptStartedAt
          : undefined,
      completedAt: timestampMs,
      retryCount:
        previous?.attemptIndex === attemptIndex
          ? previous.retryCount
          : undefined,
      maxRetries:
        previous?.attemptIndex === attemptIndex
          ? previous.maxRetries
          : undefined,
      failureReason,
    };

    this.attempts.set(key, current);
    if (this.activeAttemptKey === key) {
      this.activeAttemptKey = undefined;
    }
    this.emitAttemptTransition(
      WORKFLOW_ATTEMPT_COMMANDS.CANCEL,
      this.cloneAttemptState(current)!,
      previous,
      timestampMs
    );
    return this.cloneAttemptState(current)!;
  }

  cancelActiveAttempt(
    failureReason?: string,
    timestampMs: number = Date.now()
  ): WorkflowAttemptState | undefined {
    if (!this.activeAttemptKey) {
      return undefined;
    }

    const activeAttempt = this.attempts.get(this.activeAttemptKey);
    if (!activeAttempt) {
      this.activeAttemptKey = undefined;
      return undefined;
    }

    return this.cancelAttempt(
      activeAttempt.target,
      activeAttempt.attemptIndex,
      failureReason,
      timestampMs
    );
  }

  // ─── Named transitions ────────────────────────────────────────────────────────

  /**
   * Begin execution: → RUNNING.
   * Clears the stopped flag so resume detection works correctly.
   */
  startExecution(): boolean {
    if (this._status === EXECUTION_STATES.CANCELLING) {
      return false;
    }

    if (this._status === EXECUTION_STATES.RUNNING && !this._stopped) {
      return false;
    }

    this.absorbDormantDuration();

    const previous = this.getSnapshot();
    this._status = EXECUTION_STATES.RUNNING;
    this._stopped = false;
    this.emitTransition(WORKFLOW_RUNTIME_COMMANDS.START_EXECUTION, previous);
    return true;
  }

  /**
   * Request pause: RUNNING → PAUSING.
   * The executor will transition to PAUSED after the current step completes.
   * Call confirmPaused() at that boundary, or cancelPause() to abort.
   */
  pause(): boolean {
    if (this._status !== EXECUTION_STATES.RUNNING) {
      return false;
    }

    const previous = this.getSnapshot();
    this._status = EXECUTION_STATES.PAUSING;
    this.emitTransition(WORKFLOW_RUNTIME_COMMANDS.PAUSE, previous);
    return true;
  }

  /**
   * Confirm the pause: PAUSING → PAUSED.
   * Called by the executor when the current step finishes and the pause takes effect.
   * Records pausedTime so resume() can compute the paused duration.
   */
  confirmPaused(): boolean {
    if (this._status !== EXECUTION_STATES.PAUSING) {
      return false;
    }

    const previous = this.getSnapshot();
    this._status = EXECUTION_STATES.PAUSED;
    this._pausedTime ??= Date.now();
    this.emitTransition(WORKFLOW_RUNTIME_COMMANDS.CONFIRM_PAUSED, previous);
    return true;
  }

  /**
   * Cancel a pending pause request: PAUSING → RUNNING.
   * Called when the user cancels the pause before the current step finishes.
   */
  cancelPause(): boolean {
    if (this._status !== EXECUTION_STATES.PAUSING) {
      return false;
    }

    const previous = this.getSnapshot();
    this._status = EXECUTION_STATES.RUNNING;
    this.emitTransition(WORKFLOW_RUNTIME_COMMANDS.CANCEL_PAUSE, previous);
    return true;
  }

  /**
   * Resume execution: PAUSED/STOPPED → RUNNING.
   * Accumulates paused duration if resuming from PAUSED, then clears the stopped flag.
   */
  resume(): boolean {
    if (
      this._status !== EXECUTION_STATES.PAUSED &&
      this._status !== EXECUTION_STATES.STOPPED
    ) {
      return false;
    }

    this.absorbDormantDuration();

    const previous = this.getSnapshot();
    this._stopped = false;
    this._status = EXECUTION_STATES.RUNNING;
    this.emitTransition(WORKFLOW_RUNTIME_COMMANDS.RESUME, previous);
    return true;
  }

  /**
   * Request stop: → CANCELLING.
   * Sets the stopped flag so the executor loop can detect it immediately.
   * Call confirmStopped() once the CLI process actually terminates.
   */
  requestStop(): boolean {
    if (this._status === EXECUTION_STATES.CANCELLING && this._stopped) {
      return false;
    }

    const timestampMs = Date.now();
    this.cancelActiveAttempt(undefined, timestampMs);

    const previous = this.getSnapshot();
    this._status = EXECUTION_STATES.CANCELLING;
    this._stopped = true;
    this.emitTransition(
      WORKFLOW_RUNTIME_COMMANDS.REQUEST_STOP,
      previous,
      timestampMs
    );
    return true;
  }

  /**
   * Confirm the process exited: CANCELLING → STOPPED.
   */
  confirmStopped(): boolean {
    if (this._status !== EXECUTION_STATES.CANCELLING) {
      return false;
    }

    const previous = this.getSnapshot();
    this.finishExecutionTimer();
    this._status = EXECUTION_STATES.STOPPED;
    this.emitTransition(WORKFLOW_RUNTIME_COMMANDS.CONFIRM_STOPPED, previous);
    return true;
  }

  /**
   * Mark the run as successfully completed: → COMPLETED.
   */
  complete(): boolean {
    if (this._status === EXECUTION_STATES.COMPLETED && !this._stopped) {
      return false;
    }

    const previous = this.getSnapshot();
    this.finishExecutionTimer();
    this._stopped = false;
    this._status = EXECUTION_STATES.COMPLETED;
    this.emitTransition(WORKFLOW_RUNTIME_COMMANDS.COMPLETE, previous);
    return true;
  }

  /**
   * Mark the run as errored: → ERROR.
   */
  fail(): boolean {
    if (this._status === EXECUTION_STATES.ERROR && !this._stopped) {
      return false;
    }

    const previous = this.getSnapshot();
    this.finishExecutionTimer();
    this._stopped = false;
    this._status = EXECUTION_STATES.ERROR;
    this.emitTransition(WORKFLOW_RUNTIME_COMMANDS.FAIL, previous);
    return true;
  }

  /**
   * Reset to idle state.
   * Used for restart(), clearQueue(), loadPrompts(), and setStartPosition().
   * Clears all timing state.
   */
  reset(): boolean {
    const changed =
      this._status !== EXECUTION_STATES.IDLE ||
      this._stopped ||
      this._startTime !== undefined ||
      this._pausedTime !== undefined ||
      this._totalPausedDuration !== 0 ||
      this._executionEndTime !== undefined;

    this._status = EXECUTION_STATES.IDLE;
    this._stopped = false;
    this._startTime = undefined;
    this._pausedTime = undefined;
    this._totalPausedDuration = 0;
    this._executionEndTime = undefined;
    this.attempts.clear();
    this.activeAttemptKey = undefined;
    return changed;
  }

  // ─── Edge-case overrides ──────────────────────────────────────────────────────

  /**
   * Re-open a completed run for manual continuation.
   * Used when prompts are appended after completion and the user can resume.
   */
  reopenForContinuation(): boolean {
    if (this._status === EXECUTION_STATES.STOPPED && this._stopped) {
      return false;
    }

    const previous = this.getSnapshot();
    this._pausedTime = undefined;
    this._status = EXECUTION_STATES.STOPPED;
    this._stopped = true;
    this.emitTransition(
      WORKFLOW_RUNTIME_COMMANDS.REOPEN_FOR_CONTINUATION,
      previous
    );
    return true;
  }

  // ─── Execution timer ──────────────────────────────────────────────────────────

  /**
   * Start tracking execution time. Call once per run before the executor loop begins.
   * Resets totalPausedDuration so pause accounting is clean for the new run.
   */
  startExecutionTimer(): boolean {
    if (this._startTime !== undefined) {
      return false;
    }

    this._startTime = Date.now();
    this._totalPausedDuration = 0;
    this._executionEndTime = undefined;
    return true;
  }

  /**
   * Compute wall-clock elapsed time minus any accumulated paused duration.
   * Returns 0 if the timer has not been started.
   */
  getActiveExecutionTime(): number {
    if (this._startTime === undefined) {
      return 0;
    }

    const referenceTime = this._executionEndTime ?? Date.now();
    const activePauseDuration =
      this._pausedTime !== undefined ? referenceTime - this._pausedTime : 0;

    return (
      referenceTime -
      this._startTime -
      this._totalPausedDuration -
      activePauseDuration
    );
  }

  // ─── State restoration ────────────────────────────────────────────────────────

  /**
   * Restore the state machine from a persisted snapshot.
   * Used after full state reloads — clearQueue(), loadPrompts(), restoreFromWorkingFile().
   * Clears timing fields that are not persisted (startTime, pausedTime).
   */
  restore(snapshot: WorkflowRuntimeState): void {
    this._status = snapshot.status;
    this._stopped = snapshot.stopped;
    this._startTime = snapshot.startTime;
    this._pausedTime = snapshot.pausedTime;
    this._totalPausedDuration = snapshot.totalPausedDuration;
    this._executionEndTime = snapshot.executionEndTime;
    this.attempts.clear();
    this.activeAttemptKey = undefined;
  }

  private finishExecutionTimer(): void {
    const now = Date.now();
    if (this._pausedTime !== undefined) {
      this._totalPausedDuration += now - this._pausedTime;
      this._pausedTime = undefined;
    }
    this._executionEndTime = this._startTime !== undefined ? now : undefined;
  }

  /**
   * Inverse of finishExecutionTimer(): fold the interval during which the timer
   * was not advancing into totalPausedDuration, so re-entering RUNNING picks the
   * clock back up where it stopped.
   *
   * Two intervals qualify, and finishExecutionTimer() guarantees at most one is
   * open at a time:
   *   - pausedTime        — a confirmed PAUSED window
   *   - executionEndTime  — a terminal freeze (COMPLETED/STOPPED/ERROR)
   *
   * The terminal one is easy to overlook because a terminal run looks finished,
   * but appending a step to a completed run re-opens that same run rather than
   * starting a new one — `startExecutionTimer()` is then a no-op (startTime is
   * already set), so without this the dormant gap is counted as execution time
   * and the dashboard's elapsed timer reads the age of the run instead of its
   * duration. A run continued the next day showed "4461:39".
   *
   * The reference-time arithmetic mirrors getActiveExecutionTime() exactly, so
   * the reported elapsed time is continuous across the transition.
   */
  private absorbDormantDuration(): void {
    const now = Date.now();
    // A terminal freeze stopped the clock, so it — not now — is what any open
    // pause window was measured against, exactly as getActiveExecutionTime()
    // resolves its own reference time.
    const frozenAt = this._executionEndTime ?? now;

    if (this._pausedTime !== undefined) {
      this._totalPausedDuration += Math.max(0, frozenAt - this._pausedTime);
      this._pausedTime = undefined;
    }

    if (this._executionEndTime !== undefined) {
      this._totalPausedDuration += Math.max(0, now - this._executionEndTime);
      this._executionEndTime = undefined;
    }
  }
}
