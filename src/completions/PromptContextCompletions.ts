import {
  COMPLETION_ITEM_KINDS,
  PRIOR_CONTEXT_REFERENCE_KINDS,
  RETRY_PROMPT_PLACEHOLDERS,
  SCRIPT_OUTPUT_SOURCES,
} from "../types/DashboardConstants";
import { fuzzyMatches } from "./FuzzyRanking";
import type { PlainCompletionItem } from "./CompletionCore";

export interface PromptCompletionWorkflowContext {
  /** Names in runtime order, including only steps visible at this prompt. */
  stepNames: readonly (string | undefined)[];
  vars: Readonly<Record<string, unknown>>;
  field: "prompt" | "retryPrompt";
  hasPreCondition: boolean;
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
  const keywords = [
    {
      label: PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS,
      detail: "Output of the previous step",
    },
    {
      label: `${PRIOR_CONTEXT_REFERENCE_KINDS.PREVIOUS}:`,
      detail: "Last N step outputs",
    },
    {
      label: PRIOR_CONTEXT_REFERENCE_KINDS.ALL,
      detail: "Outputs of all prior steps",
    },
    {
      label: PRIOR_CONTEXT_REFERENCE_KINDS.FINAL_STEP,
      detail: "Previous finalStep output",
    },
    {
      label: PRIOR_CONTEXT_REFERENCE_KINDS.ALL_FINAL_STEP,
      detail: "All finalStep outputs",
    },
    {
      label: `${PRIOR_CONTEXT_REFERENCE_KINDS.STEP}:`,
      detail: "Specific prior step outputs",
      icon: "book",
    },
    ...[
      SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
      SCRIPT_OUTPUT_SOURCES.END_CONDITION,
    ]
      .filter(
        (phase) =>
          phase !== SCRIPT_OUTPUT_SOURCES.PRE_CONDITION ||
          context.hasPreCondition
      )
      .filter(
        (phase) =>
          phase !== SCRIPT_OUTPUT_SOURCES.END_CONDITION ||
          context.field === "retryPrompt"
      )
      .flatMap((phase) =>
        Object.values(RETRY_PROMPT_PLACEHOLDERS).map((field) => ({
          label: `${phase}:${field}`,
          detail: `${phase === SCRIPT_OUTPUT_SOURCES.PRE_CONDITION ? "Pre-condition" : "End-condition"} script ${field}`,
          icon:
            phase === SCRIPT_OUTPUT_SOURCES.PRE_CONDITION
              ? "shield"
              : "checklist",
        }))
      ),
  ];
  const scoped = keywords
    .filter(
      (keyword) =>
        !(keyword.label === stepPrefix && stepQuery !== undefined) &&
        fuzzyMatches(keyword.label, filterText)
    )
    .map((keyword) => ({
      ...keyword,
      kind: COMPLETION_ITEM_KINDS.KEYWORD,
      insertText: keyword.label,
    }));
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
  filterText: string
): PlainCompletionItem[] {
  return Object.keys(vars)
    .filter((name) => /^\w+$/.test(name) && fuzzyMatches(name, filterText))
    .sort()
    .map((name) => ({
      label: name,
      kind: COMPLETION_ITEM_KINDS.VARIABLE,
      insertText: `${name}}} `,
      detail: "Workflow variable",
      icon: "symbol-variable",
    }));
}
