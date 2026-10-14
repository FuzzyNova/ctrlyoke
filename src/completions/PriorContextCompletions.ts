import {
  COMPLETION_ITEM_KINDS,
  RETRY_PROMPT_PLACEHOLDERS,
  SCRIPT_OUTPUT_SOURCES,
} from "../types/DashboardConstants";
import { fuzzyMatches } from "./FuzzyRanking";
import type { PlainCompletionItem } from "./CompletionCore";

/** Shared prior-context completion list used by hosts and contextual editors. */
export function getPriorContextCompletionItems(
  filterText: string
): PlainCompletionItem[] {
  const keywords = [
    { label: "previous", detail: "Output of the previous step", icon: "book" },
    {
      label: "previous:",
      detail: "Last N step outputs, e.g. $previous:3",
      icon: "book",
    },
    { label: "all", detail: "Outputs of all prior steps", icon: "book" },
    { label: "finalStep", detail: "Previous finalStep output", icon: "book" },
    { label: "allFinalStep", detail: "All finalStep outputs", icon: "book" },
    {
      label: "step:",
      detail: "Specific steps, e.g. $step:1,3-5",
      icon: "book",
    },
    ...[
      { label: "previous:summary", example: "$previous:summary" },
      { label: "previous:summary:", example: "$previous:summary:3" },
      { label: "all:summary", example: "$all:summary" },
      { label: "finalStep:summary", example: "$finalStep:summary" },
      { label: "allFinalStep:summary", example: "$allFinalStep:summary" },
      { label: "step:summary:", example: "$step:summary:1,3-5" },
    ].map(({ label, example }) => ({
      label,
      detail: `Summary form, e.g. ${example} — deterministic excerpt: head of prompt, files changed, tail of text; no AI call`,
      icon: "book",
    })),
    ...[
      SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
      SCRIPT_OUTPUT_SOURCES.END_CONDITION,
    ].flatMap((phase) =>
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
  return keywords
    .filter((keyword) => fuzzyMatches(keyword.label, filterText))
    .map((keyword) => ({
      ...keyword,
      kind: COMPLETION_ITEM_KINDS.KEYWORD,
      insertText: keyword.label,
    }));
}
