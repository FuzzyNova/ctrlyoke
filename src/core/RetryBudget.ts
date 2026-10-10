import type { EndCondition } from "../types/CtrlYokeTypes";
import {
  CONDITION_ACTIONS,
  DEFAULT_ERROR_BEHAVIOR_RETRIES,
} from "../types/DashboardConstants";

export const RETRY_PROMPT_SOURCES = {
  AUTHORED_TEMPLATE: "authoredTemplate",
  SETTINGS_DEFAULT: "settingsDefault",
  LITERAL: "literal",
} as const;

export type RetryPromptSource =
  (typeof RETRY_PROMPT_SOURCES)[keyof typeof RETRY_PROMPT_SOURCES];

export interface RetryBudgetDefaults {
  maxRetries: number;
  retryPrompt?: string;
  passRetryPrompt?: string;
}

export interface ResolvedRetryBudget {
  maxRetries: number;
  retryPrompt: string | undefined;
  retryPromptSource: RetryPromptSource;
  passRetryPrompt: string | undefined;
  passRetryPromptSource: RetryPromptSource;
  canRetry: boolean;
  permittedRetries: number;
  anyRetryBudget: number;
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
      retryPromptSource: RETRY_PROMPT_SOURCES.LITERAL,
      passRetryPrompt: undefined,
      passRetryPromptSource: RETRY_PROMPT_SOURCES.LITERAL,
      canRetry: false,
      permittedRetries: 0,
      anyRetryBudget: 0,
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
  const retryPromptSource = hasRetryPrompt
    ? RETRY_PROMPT_SOURCES.AUTHORED_TEMPLATE
    : retryPrompt
      ? RETRY_PROMPT_SOURCES.SETTINGS_DEFAULT
      : RETRY_PROMPT_SOURCES.LITERAL;
  const hasPassRetryPrompt = Boolean(endCondition.passRetryPrompt);
  const passRetryPrompt =
    (endCondition.passRetryPrompt ?? defaults.passRetryPrompt) || undefined;
  const passRetryPromptSource = hasPassRetryPrompt
    ? RETRY_PROMPT_SOURCES.AUTHORED_TEMPLATE
    : passRetryPrompt
      ? RETRY_PROMPT_SOURCES.SETTINGS_DEFAULT
      : RETRY_PROMPT_SOURCES.LITERAL;
  const canRetry =
    Boolean(retryPrompt) || endCondition.onFail === CONDITION_ACTIONS.RETRY;
  const canPassRetry = endCondition.onPass === CONDITION_ACTIONS.RETRY;

  return {
    maxRetries,
    retryPrompt,
    retryPromptSource,
    passRetryPrompt,
    passRetryPromptSource,
    canRetry,
    permittedRetries: canRetry ? maxRetries : 0,
    anyRetryBudget: canRetry || canPassRetry ? maxRetries : 0,
  };
}
