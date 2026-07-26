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
   * and Antigravity need two checks to cover the stale Stop callback and the
   * first hold-loop recheck; Claude's notification/turn ordering does not.
   */
  staleStopGuardChecks?: number;
}

export class BackgroundFollowUpState {
  private readonly pendingTaskIds = new Set<string>();
  private readonly staleStopGuardChecks: number;
  private resumedTurnCompletionPending = false;
  private staleStopGuardChecksRemaining = 0;

  constructor(options: BackgroundFollowUpStateOptions = {}) {
    this.staleStopGuardChecks = Math.max(
      0,
      Math.floor(options.staleStopGuardChecks ?? 0)
    );
  }

  /** Record a confirmed background-task launch. Duplicate IDs are harmless. */
  launch(taskId: string): void {
    if (taskId) {
      this.pendingTaskIds.add(taskId);
    }
  }

  /** Remove a launch that failed before it could produce a resumed turn. */
  remove(taskId: string): boolean {
    return this.pendingTaskIds.delete(taskId);
  }

  /**
   * Consume a matching completion/failure notification and latch the resumed
   * turn. Unmatched and duplicate notifications do not alter state.
   */
  consumeNotification(taskId: string): boolean {
    if (!this.pendingTaskIds.delete(taskId)) {
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
    this.pendingTaskIds.clear();
    this.resumedTurnCompletionPending = false;
    this.staleStopGuardChecksRemaining = 0;
  }

  /** Whether the provider still blocks completion at the current check. */
  isCompletionBlocked(): boolean {
    if (this.pendingTaskIds.size > 0 || this.resumedTurnCompletionPending) {
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
}
