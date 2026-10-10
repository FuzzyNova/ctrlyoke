import type { EndCondition } from "../types/CtrlYokeTypes";
import {
  CONDITION_ACTIONS,
  DEFAULT_ERROR_BEHAVIOR_RETRIES,
} from "../types/DashboardConstants";

export interface RetryBudgetDefaults {
  maxRetries: number;
  retryPrompt?: string;
  passRetryPrompt?: string;
}

export interface ResolvedRetryBudget {
  maxRetries: number;
  retryPrompt: string | undefined;
  passRetryPrompt: string | undefined;
  canRetry: boolean;
  permittedRetries: number;
}

/**
 * Resolve retry settings and failure-retry eligibility without reading global
 * state.
 */
export function resolveRetryBudget(
  endCondition: EndCondition | null | undefined,
  defaults: RetryBudgetDefaults
): ResolvedRetryBudget {
  if (!endCondition) {
    return {
      maxRetries: 0,
      retryPrompt: undefined,
      passRetryPrompt: undefined,
      canRetry: false,
      permittedRetries: 0,
    };
  }

  const hasRetryPrompt = Boolean(endCondition.retryPrompt);
  const hasMaxRetries = endCondition.maxRetries !== undefined;
  const maxRetries = hasMaxRetries
    ? endCondition.maxRetries!
    : endCondition.onFail === CONDITION_ACTIONS.RETRY ||
        endCondition.onPass === CONDITION_ACTIONS.RETRY
      ? DEFAULT_ERROR_BEHAVIOR_RETRIES
      : hasRetryPrompt
        ? defaults.maxRetries
        : 0;

  const retryPrompt = hasRetryPrompt
    ? endCondition.retryPrompt
    : hasMaxRetries && endCondition.maxRetries !== 0
      ? defaults.retryPrompt || undefined
      : undefined;
  const passRetryPrompt =
    (endCondition.passRetryPrompt ?? defaults.passRetryPrompt) || undefined;
  const canRetry =
    Boolean(retryPrompt) || endCondition.onFail === CONDITION_ACTIONS.RETRY;

  return {
    maxRetries,
    retryPrompt,
    passRetryPrompt,
    canRetry,
    permittedRetries: canRetry ? maxRetries : 0,
  };
}
