import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import { tooltips } from "@codemirror/view";
import { keyboardTooltipSpace } from "@utils/keyboardTooltipSpace";
import { DEFAULT_COMPLETION_ICON } from "@utils/atomicReferences";
import type { PromptCompletionWorkflowContext } from "@root/completions/PromptContextCompletions";
import { getWorkflowVariableCompletions } from "@root/completions/PromptContextCompletions";
import { COMPLETION_ITEM_KINDS } from "@root/types/DashboardConstants";
import { VARIABLE_NAME_PATTERN_SOURCE } from "@root/utils/KeyValueKeyKinds";
import { findCustomCompletionContext } from "./promptCompletionResult";

const WORKFLOW_VARIABLE_COMPLETION_PATTERN = new RegExp(
  `\\{\\{(?:${VARIABLE_NAME_PATTERN_SOURCE})?$`
);

export interface PromptTokenCompletionOptions {
  sources: readonly CompletionSource[];
  /**
   * Restricts where the sources answer (e.g. only inside prompt-text ranges of
   * a workflow file). A source is skipped where the gate returns false.
   */
  gate?: (context: CompletionContext) => boolean;
}

/** Wrap the host-backed source with workflow-aware `$` and `{{var}}` items. */
export function createWorkflowContextCompletionSource(
  client: {
    customSource: (
      context: CompletionContext,
      escape?: import("@root/completions/WorkflowInsertEscape").InsertTextEscape
    ) => ReturnType<CompletionSource>;
  },
  getContext: (
    context: CompletionContext
  ) => PromptCompletionWorkflowContext | undefined,
  getPriorItems: (
    query: string,
    context: PromptCompletionWorkflowContext
  ) => import("@root/completions/CompletionCore").PlainCompletionItem[],
  getEscape?: (
    context: CompletionContext
  ) =>
    | import("@root/completions/WorkflowInsertEscape").InsertTextEscape
    | undefined
): CompletionSource {
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const variable = context.matchBefore(WORKFLOW_VARIABLE_COMPLETION_PATTERN);
    if (variable) {
      const query = variable.text.slice(2);
      const vars = getContext(context)?.vars ?? {};
      const hasClosingBraces =
        context.state.doc.sliceString(context.pos, context.pos + 2) === "}}";
      const items = getWorkflowVariableCompletions(
        vars,
        query,
        hasClosingBraces
      );
      if (!items.length) return null;
      return {
        from: variable.from + 2,
        to: context.pos,
        options: items.map((item) => ({
          label: item.label,
          detail: item.detail,
          apply: item.insertText,
          type: "symbol-variable",
          boost: -items.indexOf(item),
        })),
      };
    }
    const trigger = findCustomCompletionContext(before, line.from);
    if (trigger?.trigger === "$") {
      const workflowContext = getContext(context);
      if (!workflowContext) {
        return client.customSource(context, getEscape?.(context));
      }
      const items = getPriorItems(trigger.query, workflowContext);
      return items.length
        ? {
            from: trigger.from + 1,
            to: context.pos,
            options: items.map((item, index) => ({
              label: item.label,
              detail: item.detail,
              apply: item.label.endsWith(":")
                ? item.insertText
                : `${item.insertText} `,
              type:
                item.icon ||
                (item.kind === COMPLETION_ITEM_KINDS.VARIABLE
                  ? "symbol-variable"
                  : "book"),
              boost: -index,
            })),
          }
        : null;
    }
    return client.customSource(context, getEscape?.(context));
  };
}

function gateSources({
  sources,
  gate,
}: PromptTokenCompletionOptions): CompletionSource[] {
  if (!gate) return [...sources];
  return sources.map(
    (source): CompletionSource =>
      (context): CompletionResult | Promise<CompletionResult | null> | null =>
        gate(context) ? source(context) : null
  );
}

/**
 * Tooltip + autocompletion config for an editor whose only completion sources
 * are the prompt-token ones (`override`). Fine for the prompt editor, which has
 * no language server; an editor that already has other sources must use
 * {@link promptTokenLanguageDataExtension} so they combine.
 */
export function promptTokenCompletionExtension(
  options: PromptTokenCompletionOptions
): Extension {
  return [
    // Mount autocomplete tooltips on document.body so they escape the
    // overflow:hidden ancestors (critical on iOS where CodeMirror forces
    // position:absolute for tooltips, which causes them to be clipped and
    // hidden behind the EditorFooter). The body container is outside any
    // overflow:hidden chain, so the tooltip renders above the footer.
    tooltips({
      parent: document.body,
      tooltipSpace: keyboardTooltipSpace,
    }),
    autocompletion({
      override: gateSources(options),
      activateOnTyping: true,
      closeOnBlur: true,
      optionClass: (completion) =>
        `cm-completion-${completion.type || DEFAULT_COMPLETION_ICON}`,
      // `type` is a codicon name (see COMPLETION_KIND_ICONS), not
      // CodeMirror's own semantic bucket vocabulary — icons:false turns
      // off CM's built-in char-glyph icon renderer (ƒ, ○, 𝑥, ...) so
      // this is the only icon source, for every completion kind, not
      // just file/folder.
      icons: false,
      addToOptions: [
        {
          render: (completion) => {
            const icon = document.createElement("span");
            icon.className = `cm-completionIcon codicon codicon-${completion.type || DEFAULT_COMPLETION_ICON}`;
            return icon;
          },
          position: 20, // Position before label
        },
      ],
    }),
  ];
}

/**
 * The same sources registered as language data (`languageData.of({ autocomplete })`),
 * the mechanism language-server completion also uses, so they merge into one
 * dropdown beside whatever `basicSetup` and other sources contribute.
 */
export function promptTokenLanguageDataExtension(
  options: PromptTokenCompletionOptions
): Extension {
  return gateSources(options).map((source) =>
    EditorState.languageData.of(() => [{ autocomplete: source }])
  );
}
