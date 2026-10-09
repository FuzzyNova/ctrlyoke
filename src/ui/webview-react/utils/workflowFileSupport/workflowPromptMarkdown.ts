import { LanguageSupport } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type PluginValue,
} from "@codemirror/view";
import { RangeSetBuilder, type StateField } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { parseMixed, type Input } from "@lezer/common";
import { yamlLanguage } from "@codemirror/lang-yaml";
import {
  WORKFLOW_LOCATION_ROLES,
  type CtrlYokeFileKind,
} from "@root/types/DashboardConstants";
import { getWorkflowTextSpans } from "@root/completions/WorkflowPromptRanges";
import type { WorkflowTextSpan } from "@root/completions/WorkflowTextDecoding";
import { findCodeRanges } from "@root/utils/FileReferenceParser";
import {
  createPromptMarkdownLanguage,
  PROMPT_MARKDOWN_NODE_NAMES,
} from "@utils/codemirrorLanguage";
import { createCtrlYokeHighlightStyle } from "@utils/syntaxPalette";

/** YAML with Markdown mounted only over decoded ctrlyoke prompt block scalars. */
export function createWorkflowPromptMarkdownLanguage(kind: CtrlYokeFileKind) {
  const markdownLanguage = createPromptMarkdownLanguage();
  const spansByInput = new WeakMap<
    Input,
    ReturnType<typeof getWorkflowTextSpans>
  >();
  return new LanguageSupport(
    yamlLanguage.configure({
      wrap: parseMixed((node, input) => {
        if (node.name !== "BlockLiteral") return null;
        let spans = spansByInput.get(input);
        if (!spans) {
          spans = getWorkflowTextSpans(input.read(0, input.length), kind);
          spansByInput.set(input, spans);
        }
        const span = spans.find(
          (candidate) =>
            candidate.role === WORKFLOW_LOCATION_ROLES.PROMPT_TEXT &&
            candidate.sourceRange.start < node.to &&
            candidate.sourceRange.end > node.from
        );
        if (!span?.exact || span.text.length === 0) return null;

        // YAML removes the common block indentation before runtime expansion.
        // Leave that indentation out of the Markdown overlay too, so headings
        // and fences are parsed at their actual Markdown column.
        const overlay: Array<{ from: number; to: number }> = [];
        let lineStart = 0;
        while (lineStart < span.text.length) {
          const newline = span.text.indexOf("\n", lineStart);
          const lineEnd = newline < 0 ? span.text.length : newline;
          let contentStart = lineStart;
          while (
            contentStart < lineEnd &&
            (span.text[contentStart] === " " ||
              span.text[contentStart] === "\t")
          ) {
            contentStart++;
          }
          if (contentStart < lineEnd) {
            overlay.push({
              from: span.toSourceOffset(contentStart),
              to: span.toSourceOffset(newline < 0 ? lineEnd : newline + 1),
            });
          }
          if (newline < 0) break;
          lineStart = newline + 1;
        }
        return overlay.length
          ? { parser: markdownLanguage.language.parser, overlay }
          : null;
      }),
    })
  );
}

/** Apply the shared Markdown token styles through decoded YAML source maps. */
export function createWorkflowPromptMarkdownDecorations(
  rangesField: StateField<readonly WorkflowTextSpan[]>
) {
  const language = createPromptMarkdownLanguage();
  const style = createCtrlYokeHighlightStyle();
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: ReturnType<RangeSetBuilder<Decoration>["finish"]>;

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
          const tree = language.language.parser.parse(span.text);
          const codeRanges = findCodeRanges(span.text);
          const unclosedFences: Array<{ from: number; to: number }> = [];
          tree.iterate({
            enter: (node) => {
              if (node.name !== PROMPT_MARKDOWN_NODE_NAMES.FENCED_CODE) return;
              let marks = 0;
              for (
                let child = node.node.firstChild;
                child;
                child = child.nextSibling
              ) {
                if (child.name === PROMPT_MARKDOWN_NODE_NAMES.CODE_MARK)
                  marks++;
              }
              if (marks < 2)
                unclosedFences.push({ from: node.from, to: node.to });
            },
          });

          highlightTree(tree, style, (from, to, classes) => {
            if (!classes) return;
            if (
              codeRanges.some(
                (range) =>
                  range.from <= from &&
                  range.to >= to &&
                  unclosedFences.some(
                    (fence) => range.from >= fence.from && range.to <= fence.to
                  )
              )
            )
              return;
            const sourceFrom = span.toSourceOffset(from);
            const sourceTo = span.toSourceOffset(to);
            if (sourceFrom < sourceTo) {
              builder.add(
                sourceFrom,
                sourceTo,
                Decoration.mark({ class: classes })
              );
            }
          });
        }
        return builder.finish();
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );
}
