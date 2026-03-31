import { EXECUTION_STATES } from "../types/FlightPathTypes";
import type { ExecutionState } from "../types/DashboardConstants";

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

  // ─── Named transitions ────────────────────────────────────────────────────────

  /**
   * Begin execution: → RUNNING.
   * Clears the stopped flag so resume detection works correctly.
   */
  startExecution(): void {
    this._status = EXECUTION_STATES.RUNNING;
    this._stopped = false;
  }

  /**
   * Pause execution: RUNNING → PAUSED.
   * Records pausedTime so resume() can compute the paused duration.
   */
  pause(): void {
    this._status = EXECUTION_STATES.PAUSED;
    this._pausedTime = Date.now();
  }

  /**
   * Resume execution: PAUSED/STOPPED → RUNNING.
   * Accumulates paused duration if resuming from PAUSED, then clears the stopped flag.
   */
  resume(): void {
    if (this._pausedTime !== undefined) {
      this._totalPausedDuration += Date.now() - this._pausedTime;
      this._pausedTime = undefined;
    }
    this._stopped = false;
    this._status = EXECUTION_STATES.RUNNING;
  }

  /**
   * Request stop: → CANCELLING.
   * Sets the stopped flag so the executor loop can detect it immediately.
   * Call confirmStopped() once the CLI process actually terminates.
   */
  requestStop(): void {
    this._status = EXECUTION_STATES.CANCELLING;
    this._stopped = true;
  }

  /**
   * Confirm the process exited: CANCELLING → STOPPED.
   */
  confirmStopped(): void {
    this._status = EXECUTION_STATES.STOPPED;
  }

  /**
   * Mark the run as successfully completed: → COMPLETED.
   */
  complete(): void {
    this._status = EXECUTION_STATES.COMPLETED;
  }

  /**
   * Mark the run as errored: → ERROR.
   */
  fail(): void {
    this._status = EXECUTION_STATES.ERROR;
  }

  /**
   * Reset to idle state.
   * Used for restart(), clearQueue(), loadPrompts(), and setStartPosition().
   * Clears all timing state.
   */
  reset(): void {
    this._status = EXECUTION_STATES.IDLE;
    this._stopped = false;
    this._startTime = undefined;
    this._pausedTime = undefined;
    this._totalPausedDuration = 0;
  }

  // ─── Edge-case overrides ──────────────────────────────────────────────────────

  /**
   * Override status directly for edge-case transitions that do not fit a named method.
   * Example: appendPrompts() transitions COMPLETED → STOPPED without passing through CANCELLING.
   * Prefer named transition methods where possible.
   */
  setStatus(status: ExecutionState): void {
    this._status = status;
  }

  /**
   * Override the stopped flag directly.
   * Example: appendPrompts() sets stopped=true alongside the STOPPED status override.
   */
  setStopped(value: boolean): void {
    this._stopped = value;
  }

  // ─── Execution timer ──────────────────────────────────────────────────────────

  /**
   * Start tracking execution time. Call once per run before the executor loop begins.
   * Resets totalPausedDuration so pause accounting is clean for the new run.
   */
  startExecutionTimer(): void {
    this._startTime = Date.now();
    this._totalPausedDuration = 0;
  }

  /**
   * Compute wall-clock elapsed time minus any accumulated paused duration.
   * Returns 0 if the timer has not been started.
   */
  getActiveExecutionTime(): number {
    if (this._startTime === undefined) {
      return 0;
    }
    return Date.now() - this._startTime - this._totalPausedDuration;
  }

  // ─── State restoration ────────────────────────────────────────────────────────

  /**
   * Restore the state machine from a persisted snapshot.
   * Used after full state reloads — clearQueue(), loadPrompts(), restoreFromWorkingFile().
   * Clears timing fields that are not persisted (startTime, pausedTime).
   */
  restore(
    status: ExecutionState,
    stopped: boolean,
    totalPausedDuration: number
  ): void {
    this._status = status;
    this._stopped = stopped;
    this._startTime = undefined;
    this._pausedTime = undefined;
    this._totalPausedDuration = totalPausedDuration;
  }
}
