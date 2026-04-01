import { EXECUTION_STATES } from "../types/FlightPathTypes";
import type { ExecutionState } from "../types/DashboardConstants";
import type {
  WorkflowRuntimeCommand,
  WorkflowRuntimeState,
  WorkflowRuntimeTransition,
} from "../types/FlightPathTypes";
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
  private readonly onTransitionEmitter =
    new TypedEmitter<WorkflowRuntimeTransition>();

  public readonly onDidTransition = this.onTransitionEmitter.event;

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
    };
  }

  private emitTransition(
    command: WorkflowRuntimeCommand,
    previous: WorkflowRuntimeState
  ): void {
    this.onTransitionEmitter.fire({
      command,
      previous,
      current: this.getSnapshot(),
      timestampMs: Date.now(),
    });
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

    if (this._pausedTime !== undefined) {
      this._totalPausedDuration += Date.now() - this._pausedTime;
      this._pausedTime = undefined;
    }

    const previous = this.getSnapshot();
    this._status = EXECUTION_STATES.RUNNING;
    this._stopped = false;
    this.emitTransition("startExecution", previous);
    return true;
  }

  /**
   * Pause execution: RUNNING → PAUSED.
   * Records pausedTime so resume() can compute the paused duration.
   */
  pause(): boolean {
    if (this._status !== EXECUTION_STATES.RUNNING) {
      return false;
    }

    const previous = this.getSnapshot();
    this._status = EXECUTION_STATES.PAUSED;
    this._pausedTime ??= Date.now();
    this.emitTransition("pause", previous);
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

    if (this._pausedTime !== undefined) {
      this._totalPausedDuration += Date.now() - this._pausedTime;
      this._pausedTime = undefined;
    }
    const previous = this.getSnapshot();
    this._stopped = false;
    this._status = EXECUTION_STATES.RUNNING;
    this.emitTransition("resume", previous);
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

    const previous = this.getSnapshot();
    this._status = EXECUTION_STATES.CANCELLING;
    this._stopped = true;
    this.emitTransition("requestStop", previous);
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
    this._pausedTime = undefined;
    this._status = EXECUTION_STATES.STOPPED;
    this.emitTransition("confirmStopped", previous);
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
    this._pausedTime = undefined;
    this._stopped = false;
    this._status = EXECUTION_STATES.COMPLETED;
    this.emitTransition("complete", previous);
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
    this._pausedTime = undefined;
    this._stopped = false;
    this._status = EXECUTION_STATES.ERROR;
    this.emitTransition("fail", previous);
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
      this._totalPausedDuration !== 0;

    this._status = EXECUTION_STATES.IDLE;
    this._stopped = false;
    this._startTime = undefined;
    this._pausedTime = undefined;
    this._totalPausedDuration = 0;
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
    this.emitTransition("reopenForContinuation", previous);
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

    const activePauseDuration =
      this._pausedTime !== undefined ? Date.now() - this._pausedTime : 0;

    return (
      Date.now() -
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
  }
}
