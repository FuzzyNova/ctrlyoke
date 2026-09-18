import type { ConditionEvaluationSummary } from "../types/CtrlYokeTypes";
import {
  DEFAULT_COMPARE_SOURCE,
  RETRY_PROMPT_PLACEHOLDERS,
  SCRIPT_OUTPUT_SOURCES,
  type RetryPromptPlaceholder,
} from "../types/DashboardConstants";
import { parseConditionOutputRefs } from "../utils/FileReferenceParser";

type ConditionOutputPhase =
  | typeof SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
  | typeof SCRIPT_OUTPUT_SOURCES.END_CONDITION;

export interface ConditionOutputContext {
  preCondition?: ConditionEvaluationSummary;
  endCondition?: ConditionEvaluationSummary;
}

export interface ConditionOutputSubstitutionResult {
  text: string;
  /** $phase:field tokens found with no summary for that phase — feeds a diagnostic/warning. */
  unresolved: Array<{
    phase: ConditionOutputPhase;
    field: string;
    token: string;
  }>;
}

const FIELD_VALUES: Record<
  RetryPromptPlaceholder,
  (summary: ConditionEvaluationSummary) => string
> = {
  [RETRY_PROMPT_PLACEHOLDERS.STDOUT]: (summary) => summary.stdout.trim(),
  [RETRY_PROMPT_PLACEHOLDERS.STDERR]: (summary) => summary.stderr.trim(),
  [RETRY_PROMPT_PLACEHOLDERS.EXPECTED_VALUE]: (summary) =>
    summary.expected ?? "",
  [RETRY_PROMPT_PLACEHOLDERS.ACTUAL_VALUE]: (summary) => summary.actual.trim(),
  [RETRY_PROMPT_PLACEHOLDERS.EXIT_CODE]: (summary) =>
    String(summary.exitCode ?? ""),
  [RETRY_PROMPT_PLACEHOLDERS.COMPARE_SOURCE]: (summary) =>
    summary.compareSource ?? DEFAULT_COMPARE_SOURCE,
};

function isRetryPromptPlaceholder(
  field: string
): field is RetryPromptPlaceholder {
  return Object.values(RETRY_PROMPT_PLACEHOLDERS).some(
    (placeholder) => placeholder === field
  );
}

function getSummary(
  phase: ConditionOutputPhase,
  context: ConditionOutputContext
): ConditionEvaluationSummary | undefined {
  return phase === SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
    ? context.preCondition
    : context.endCondition;
}

export function substituteConditionOutputRefs(
  text: string,
  context: ConditionOutputContext
): ConditionOutputSubstitutionResult {
  // parseConditionOutputRefs masks fenced blocks itself, and masking is a
  // 1:1 character substitution — so its offsets index the original text.
  const matches = parseConditionOutputRefs(text);
  const unresolved: ConditionOutputSubstitutionResult["unresolved"] = [];
  let cursor = 0;
  let substitutedText = "";

  for (const match of matches) {
    substitutedText += text.slice(cursor, match.startOffset);
    const summary = getSummary(match.phase, context);
    const replacement = isRetryPromptPlaceholder(match.field)
      ? FIELD_VALUES[match.field]
      : undefined;

    if (!replacement) {
      substitutedText += match.token;
    } else if (!summary) {
      substitutedText += match.token;
      unresolved.push({
        phase: match.phase,
        field: match.field,
        token: match.token,
      });
    } else {
      substitutedText += replacement(summary);
    }
    cursor = match.endOffset;
  }

  substitutedText += text.slice(cursor);
  return { text: substitutedText, unresolved };
}
