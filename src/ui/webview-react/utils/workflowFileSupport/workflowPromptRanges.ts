import { StateField } from "@codemirror/state";
import { getWorkflowTextSpans } from "@root/completions/WorkflowPromptRanges";
import type { WorkflowTextSpan } from "@root/completions/WorkflowTextDecoding";
import type { CtrlYokeFileKind } from "@root/types/DashboardConstants";

/**
 * Prompt text spans for the current editor document. Kept as decoded spans so
 * future consumers (including nested Markdown support) can map syntax ranges
 * back through `toSourceOffset` without reparsing or guessing YAML offsets.
 */
export function createWorkflowPromptRangesField(kind: CtrlYokeFileKind) {
  const readSpans = (doc: { toString(): string }) =>
    getWorkflowTextSpans(doc.toString(), kind);

  return StateField.define<readonly WorkflowTextSpan[]>({
    create: (state) => readSpans(state.doc),
    update: (spans, transaction) =>
      transaction.docChanged ? readSpans(transaction.newDoc) : spans,
  });
}
