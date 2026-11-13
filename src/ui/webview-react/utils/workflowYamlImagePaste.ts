import type { EditorView } from "@codemirror/view";
import { CTRLYOKE_FILE_KINDS } from "@root/types/DashboardConstants";
import { YAML_SCALAR_STYLES } from "@root/completions/WorkflowLocationTypes";
import type { WorkflowTextSpan } from "@root/completions/WorkflowTextDecoding";
import { escapeJsonStringFragment } from "@root/utils/JsonStringEscape";

/** Quote a plain YAML prompt before an image reference is inserted at its start. */
export function prepareYamlPromptImageInsertion(
  view: EditorView,
  spans: readonly WorkflowTextSpan[],
  from: number,
  to: number
): void {
  const span = spans.find(
    (candidate) =>
      candidate.exact &&
      candidate.kind === CTRLYOKE_FILE_KINDS.WORKFLOW_YAML &&
      candidate.scalarStyle === YAML_SCALAR_STYLES.PLAIN &&
      from === candidate.sourceRange.start &&
      to <= candidate.sourceRange.end
  );
  if (!span) return;
  const quoted = `"${escapeJsonStringFragment(span.text)}"`;
  view.dispatch({
    changes: {
      from: span.sourceRange.start,
      to: span.sourceRange.end,
      insert: quoted,
    },
    selection: { anchor: span.sourceRange.start + 1 },
    userEvent: "input.type",
  });
}
