import {
  COMPLETION_ITEM_KINDS,
  PRIOR_CONTEXT_REFERENCE_KINDS,
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

/** Apply position and field rules to the shared prior-context list. */
export function getContextualPriorCompletions(
  filterText: string,
  context: PromptCompletionWorkflowContext
): PlainCompletionItem[] {
  const stepPrefix = `${PRIOR_CONTEXT_REFERENCE_KINDS.STEP}:`;
  const stepQuery = filterText.startsWith(stepPrefix)
    ? filterText.slice(stepPrefix.length)
    : undefined;
  const scoped = getPriorContextCompletionItems(filterText)
    .filter(
      (keyword) =>
        !(keyword.label === stepPrefix && stepQuery !== undefined) &&
        (context.stepCount > 0 ||
          ![
            PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS,
            `${PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS}:`,
            PRIOR_CONTEXT_REFERENCE_KINDS.ALL,
            stepPrefix,
          ].includes(keyword.label)) &&
        (context.hasFinalStep ||
          !new Set<string>([
            PRIOR_CONTEXT_REFERENCE_KINDS.FINAL_STEP,
            PRIOR_CONTEXT_REFERENCE_KINDS.ALL_FINAL_STEP,
          ]).has(keyword.label)) &&
        (keyword.label.startsWith(`${SCRIPT_OUTPUT_SOURCES.PRE_CONDITION}:`)
          ? context.hasPreCondition
          : true) &&
        (keyword.label.startsWith(`${SCRIPT_OUTPUT_SOURCES.END_CONDITION}:`)
          ? context.field === PROMPT_DIAGNOSTIC_FIELDS.RETRY_PROMPT
          : true) &&
        fuzzyMatches(keyword.label, filterText)
    )
    .map((keyword) => ({ ...keyword, kind: COMPLETION_ITEM_KINDS.KEYWORD }));
  if (stepQuery === undefined) return scoped;
  const steps = context.stepNames.flatMap((name, index) => {
    const number = index + 1;
    const label = `${stepPrefix}${number}`;
    if (!fuzzyMatches(label, `${stepPrefix}${stepQuery}`)) return [];
    return [
      {
        label,
        kind: COMPLETION_ITEM_KINDS.KEYWORD,
        insertText: label,
        detail: name ? `Step ${number}: ${name}` : `Step ${number}`,
        icon: "book",
      },
    ];
  });
  return steps;
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
