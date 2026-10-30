import { StateEffect } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { forceLinting } from "@codemirror/lint";

// Dispatched when non-document lint inputs change (stepCount, hasFinalStep,
// hasPreCondition, mode, the spelling dictionary or custom words).
// forceLinting alone is a no-op unless a lint is already pending, so without
// this effect a prompt first linted before the workflow's steps loaded keeps
// its stale "steps do not exist" warnings until the user edits the text. The
// ref-driven linters' needsRefresh watches it.
const lintContextChangedEffect = StateEffect.define<void>();

export function isLintRefreshUpdate(update: ViewUpdate): boolean {
  return (
    update.docChanged ||
    update.viewportChanged ||
    update.transactions.some((tr) =>
      tr.effects.some((effect) => effect.is(lintContextChangedEffect))
    )
  );
}

/** Re-run linting after a non-document lint input changed (see lintContextChangedEffect). */
export function relintForContextChange(view: EditorView): void {
  view.dispatch({ effects: lintContextChangedEffect.of(undefined) });
  forceLinting(view);
}
