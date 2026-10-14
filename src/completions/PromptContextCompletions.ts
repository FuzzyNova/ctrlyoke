import {
  COMPLETION_ITEM_KINDS,
  PRIOR_CONTEXT_REFERENCE_KINDS,
  PRIOR_CONTEXT_SUMMARY_SEGMENT,
  SCRIPT_OUTPUT_SOURCES,
  PROMPT_DIAGNOSTIC_FIELDS,
  type PromptDiagnosticField,
} from "../types/DashboardConstants";
import { fuzzyMatches } from "./FuzzyRanking";
import type { PlainCompletionItem } from "./CompletionCore";
import { getPriorContextCompletionItems } from "./PriorContextCompletions";
import { VARIABLE_NAME_PATTERN } from "../utils/KeyValueKeyKinds";

export interface PromptCompletionWorkflowContext {
  /** Names in runtime order, including only steps visible at this prompt. */
  stepNames: readonly (string | undefined)[];
  vars: Readonly<Record<string, unknown>>;
  field: PromptDiagnosticField;
  hasPreCondition: boolean;
  stepCount: number;
  hasFinalStep: boolean;
}

/**
 * Apply field rules to the shared prior-context list, and list the visible
 * steps once `step:` (or `step:summary:`) is typed.
 *
 * References that a later edit could make valid are always offered: `$previous`
 * on the first step, `$finalStep` before a final step exists, `$preCondition:`
 * before a pre-condition is configured. The prompt lint flags them until then,
 * so a prompt can be written before the workflow around it. Only
 * `$endCondition:` is withheld outside a retry prompt, where no edit to the
 * workflow can make it resolve.
 */
export function getContextualPriorCompletions(
  filterText: string,
  context: PromptCompletionWorkflowContext
): PlainCompletionItem[] {
  const stepPrefix = `${PRIOR_CONTEXT_REFERENCE_KINDS.STEP}:`;
  const summaryStepPrefix = `${PRIOR_CONTEXT_REFERENCE_KINDS.STEP}${PRIOR_CONTEXT_SUMMARY_SEGMENT}:`;
  const stepListPrefix = filterText.startsWith(summaryStepPrefix)
    ? summaryStepPrefix
    : filterText.startsWith(stepPrefix)
      ? stepPrefix
      : undefined;
  const scoped = getPriorContextCompletionItems(filterText)
    .filter(
      (keyword) =>
        (keyword.label.startsWith(`${SCRIPT_OUTPUT_SOURCES.END_CONDITION}:`)
          ? context.field === PROMPT_DIAGNOSTIC_FIELDS.RETRY_PROMPT
          : true) && fuzzyMatches(keyword.label, filterText)
    )
    .map((keyword) => ({ ...keyword, kind: COMPLETION_ITEM_KINDS.KEYWORD }));
  if (stepListPrefix === undefined) return scoped;
  const summary = stepListPrefix === summaryStepPrefix;
  const steps = context.stepNames.flatMap((name, index) => {
    const number = index + 1;
    const label = `${stepListPrefix}${number}`;
    if (!fuzzyMatches(label, filterText)) return [];
    const step = name ? `Step ${number}: ${name}` : `Step ${number}`;
    return [
      {
        label,
        kind: COMPLETION_ITEM_KINDS.KEYWORD,
        insertText: label,
        detail: summary ? `${step} (summary)` : step,
        icon: "book",
      },
    ];
  });
  // After `step:`, the summary form is the one other way to go on.
  const summaryKeyword = summary
    ? []
    : scoped.filter((keyword) => keyword.label === summaryStepPrefix);
  return [...steps, ...summaryKeyword];
}

/** `{{name}}` completions use the same key syntax as VarSubstitutor. */
export function getWorkflowVariableCompletions(
  vars: Readonly<Record<string, unknown>>,
  filterText: string,
  hasClosingBraces = false
): PlainCompletionItem[] {
  return Object.keys(vars)
    .filter(
      (name) =>
        VARIABLE_NAME_PATTERN.test(name) && fuzzyMatches(name, filterText)
    )
    .sort()
    .map((name) => ({
      label: name,
      kind: COMPLETION_ITEM_KINDS.VARIABLE,
      insertText: hasClosingBraces ? name : `${name}}} `,
      detail: "Workflow variable",
      icon: "symbol-variable",
    }));
}
