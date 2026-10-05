import type { PromptAttemptStats } from "../core/WorkflowInstance";
import type { TokenStats } from "../types/WebviewMessageTypes";

/** One target's attempts, totalled for the retry summary line. */
export interface CliAttemptGroup {
  stepName: string;
  attemptCount: number;
  totalElapsed: number;
  tokenStats: TokenStats[];
}

interface CliAttemptState extends CliAttemptGroup {
  retried: boolean;
  activeAttemptCompleted: boolean;
}

/**
 * Totals each output target's attempts, queue steps and finalStep passes
 * alike, keyed by the target's output-stream key.
 */
export class CliAttemptTally {
  private readonly attempts = new Map<string, CliAttemptState>();

  start(key: string, stepName: string, attemptIndex: number): void {
    const attempt = this.attempts.get(key) ?? {
      stepName,
      attemptCount: 0,
      totalElapsed: 0,
      tokenStats: [],
      retried: false,
      activeAttemptCompleted: false,
    };
    attempt.stepName = stepName;
    attempt.attemptCount = Math.max(attempt.attemptCount, attemptIndex + 1);
    attempt.retried ||= attemptIndex > 0;
    attempt.activeAttemptCompleted = false;
    this.attempts.set(key, attempt);
  }

  /** Counts an attempt's stats once, however often its completion repeats. */
  complete(key: string, stats: PromptAttemptStats): void {
    const attempt = this.attempts.get(key);
    if (!attempt || attempt.activeAttemptCompleted) return;
    attempt.totalElapsed += stats.elapsed ?? 0;
    if (stats.tokens) attempt.tokenStats.push(stats.tokens);
    attempt.activeAttemptCompleted = true;
  }

  /** The targets that ran more than one attempt, in first-start order. */
  retriedGroups(): CliAttemptGroup[] {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.retried)
      .map(({ stepName, attemptCount, totalElapsed, tokenStats }) => ({
        stepName,
        attemptCount,
        totalElapsed,
        tokenStats,
      }));
  }

  clear(): void {
    this.attempts.clear();
  }
}
