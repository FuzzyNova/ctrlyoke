import type {
  BackgroundTaskSummary,
  BackgroundWorkHoldSnapshot,
} from "../../../types/CliOutputTypes";

/**
 * Provider-agnostic state for a CLI background task that wakes a resumed turn.
 *
 * Parsers own provider-specific launch, notification, and turn-closing
 * recognition. This class only owns the common state transitions once those
 * provider signals have been recognized.
 */
export interface BackgroundFollowUpStateOptions {
  /**
   * Number of completion checks to reject after a resumed turn closes. Copilot
   * needs two checks to cover the stale Stop callback and the first hold-loop
   * recheck. Claude's notification/turn ordering does not need this, and nor
   * does Antigravity: its transcript is tailed by an independently-polling
   * watcher (decoupled from Stop-hook timing), so by the time a Stop hook
   * fires the resumed turn has typically already closed with nothing left to
   * catch up — a guard here would just wait for a follow-up Stop hook that a
   * normal, fully-finished agy turn never emits.
   */
  staleStopGuardChecks?: number;
}

export class BackgroundFollowUpState {
  /** Pending task id -> what is known about it, for display only. */
  private readonly pendingTasks = new Map<string, BackgroundTaskSummary>();
  private readonly staleStopGuardChecks: number;
  private resumedTurnCompletionPending = false;
  private staleStopGuardChecksRemaining = 0;

  constructor(options: BackgroundFollowUpStateOptions = {}) {
    this.staleStopGuardChecks = Math.max(
      0,
      Math.floor(options.staleStopGuardChecks ?? 0)
    );
  }

  /**
   * Record a confirmed background-task launch. Duplicate IDs are harmless; a
   * repeat launch merges its summary into what is already known, so a later
   * signal can add detail (such as the provider task id) to an earlier one.
   */
  launch(taskId: string, summary: BackgroundTaskSummary = {}): void {
    if (!taskId) {
      return;
    }
    const merged: BackgroundTaskSummary = { ...this.pendingTasks.get(taskId) };
    for (const [key, value] of Object.entries(summary) as Array<
      [keyof BackgroundTaskSummary, string | undefined]
    >) {
      if (value) {
        merged[key] = value;
      }
    }
    this.pendingTasks.set(taskId, merged);
  }

  /** Remove a launch that failed before it could produce a resumed turn. */
  remove(taskId: string): boolean {
    return this.pendingTasks.delete(taskId);
  }

  /**
   * Consume a matching completion/failure notification and latch the resumed
   * turn. Unmatched and duplicate notifications do not alter state.
   */
  consumeNotification(taskId: string): boolean {
    if (!this.pendingTasks.delete(taskId)) {
      return false;
    }
    this.resumedTurnCompletionPending = true;
    return true;
  }

  /** Close the resumed turn after its provider-specific terminal event. */
  resumedTurnClosed(): void {
    if (!this.resumedTurnCompletionPending) {
      return;
    }
    this.resumedTurnCompletionPending = false;
    this.staleStopGuardChecksRemaining = this.staleStopGuardChecks;
  }

  /** Clear all state at the provider's session lifecycle boundary. */
  reset(): void {
    this.pendingTasks.clear();
    this.resumedTurnCompletionPending = false;
    this.staleStopGuardChecksRemaining = 0;
  }

  /** Whether the provider still blocks completion at the current check. */
  isCompletionBlocked(): boolean {
    if (this.pendingTasks.size > 0 || this.resumedTurnCompletionPending) {
      return true;
    }
    if (this.staleStopGuardChecksRemaining > 0) {
      this.staleStopGuardChecksRemaining--;
      return true;
    }
    return false;
  }

  /** Whether a consumed notification is still awaiting its resumed turn close. */
  isResumedTurnPending(): boolean {
    return this.resumedTurnCompletionPending;
  }

  /**
   * What is blocking completion, for display. Side-effect free, unlike
   * `isCompletionBlocked()`, so it is safe to call at any time.
   */
  snapshot(): BackgroundWorkHoldSnapshot {
    return {
      pendingTasks: [...this.pendingTasks.values()],
      awaitingResumedTurn: this.resumedTurnCompletionPending,
    };
  }
}
