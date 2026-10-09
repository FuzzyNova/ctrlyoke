import { LanguageSupport } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type PluginValue,
} from "@codemirror/view";
import { RangeSetBuilder, type StateField } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { yamlLanguage } from "@codemirror/lang-yaml";
import type { WorkflowTextSpan } from "@root/completions/WorkflowTextDecoding";
import {
  createPromptMarkdownLanguage,
  createUnclosedFenceTheme,
  PROMPT_MARKDOWN_NODE_NAMES,
} from "@utils/codemirrorLanguage";
import { createCtrlYokeHighlightStyle } from "@utils/syntaxPalette";

/** YAML with Markdown mounted only over decoded ctrlyoke prompt block scalars. */
export function createWorkflowPromptMarkdownLanguage() {
  return new LanguageSupport(yamlLanguage);
}

/** Apply the shared Markdown token styles through decoded YAML source maps. */
export function createWorkflowPromptMarkdownDecorations(
  rangesField: StateField<readonly WorkflowTextSpan[]>
) {
  const language = createPromptMarkdownLanguage();
  const style = createCtrlYokeHighlightStyle();
  type CachedSpan = {
    marks: Array<{ from: number; to: number; classes: string }>;
    unclosedFences: Array<{ from: number; to: number }>;
  };
  return [
    ViewPlugin.fromClass(
      class implements PluginValue {
        decorations: ReturnType<RangeSetBuilder<Decoration>["finish"]>;
        parsedSpans = new Map<string, CachedSpan>();

        constructor(view: EditorView) {
          this.decorations = this.build(view);
        }

        update(update: { docChanged: boolean; view: EditorView }) {
          if (update.docChanged) this.decorations = this.build(update.view);
        }

        build(view: EditorView) {
          const builder = new RangeSetBuilder<Decoration>();
          const spans = view.state.field(rangesField, false) ?? [];
          for (const span of spans) {
            if (!span.exact) continue;
            const decorations: Array<{
              from: number;
              to: number;
              decoration: Decoration;
            }> = [];
            let cached = this.parsedSpans.get(span.text);
            if (!cached) {
              const tree = language.language.parser.parse(span.text);
              const marks: CachedSpan["marks"] = [];
              const unclosedFences: CachedSpan["unclosedFences"] = [];
              tree.iterate({
                enter: (node) => {
                  if (node.name !== PROMPT_MARKDOWN_NODE_NAMES.FENCED_CODE)
                    return;
                  let codeMarks = 0;
                  for (
                    let child = node.node.firstChild;
                    child;
                    child = child.nextSibling
                  ) {
                    if (child.name === PROMPT_MARKDOWN_NODE_NAMES.CODE_MARK)
                      codeMarks++;
                  }
                  if (codeMarks < 2)
                    unclosedFences.push({ from: node.from, to: node.to });
                },
              });
              highlightTree(tree, style, (from, to, classes) => {
                if (classes) marks.push({ from, to, classes });
              });
              cached = { marks, unclosedFences };
              this.parsedSpans.set(span.text, cached);
              if (this.parsedSpans.size > 32) {
                const oldest = this.parsedSpans.keys().next().value;
                if (oldest !== undefined) this.parsedSpans.delete(oldest);
              }
            }
            for (const { from, to, classes } of cached.marks) {
              if (
                cached.unclosedFences.some(
                  (fence) => from < fence.to && to > fence.from
                )
              )
                continue;
              const sourceFrom = span.toSourceOffset(from);
              const sourceTo = span.toSourceOffset(to);
              if (sourceFrom < sourceTo) {
                decorations.push({
                  from: sourceFrom,
                  to: sourceTo,
                  decoration: Decoration.mark({ class: classes }),
                });
              }
            }
            for (const fence of cached.unclosedFences) {
              const sourceFrom = span.toSourceOffset(fence.from);
              const sourceTo = span.toSourceOffset(fence.to);
              if (sourceFrom < sourceTo) {
                decorations.push({
                  from: sourceFrom,
                  to: sourceTo,
                  decoration: Decoration.mark({ class: "cm-unclosed-fence" }),
                });
              }
            }
            decorations
              .sort(
                (left, right) => left.from - right.from || left.to - right.to
              )
              .forEach(({ from, to, decoration }) =>
                builder.add(from, to, decoration)
              );
          }
          return builder.finish();
        }
      },
      { decorations: (plugin) => plugin.decorations }
    ),
    createUnclosedFenceTheme(),
  ];
}
