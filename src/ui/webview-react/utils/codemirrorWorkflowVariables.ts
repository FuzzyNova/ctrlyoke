import { linter, type Diagnostic } from "@codemirror/lint";
import { Prec, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import { SYMBOL_ICON_COLORS } from "@utils/atomicReferences";
import { toCodeMirrorPromptDiagnostic } from "@utils/promptDiagnosticCodeMirror";
import { getUndefinedVariableDiagnostics } from "@root/utils/PromptDiagnosticRules";
import {
  findVariablePlaceholders,
  isVariableDefined,
  VARIABLE_PLACEHOLDER_DELIMITER_LENGTH,
  type VariablePlaceholder,
} from "@root/utils/VariablePlaceholders";

/**
 * `{{name}}` workflow variables in the prompt editor: a token style, a hover
 * showing the value, Ctrl/Cmd+click to the workflow's Variables, and the
 * shared undefined-variable lint with an "add to vars" quick fix.
 *
 * Deliberately a mark, not an atomic chip: the raw `{{name}}` is already short
 * and *is* the meaning, and a name is something authors edit in place. The
 * ranges come from `findVariablePlaceholders`, the same scanner
 * `VarSubstitutor` substitutes from — so a placeholder inside inline code is
 * styled (it is substituted) and one inside a fenced block is plain text (it
 * is not).
 */

export interface WorkflowVariableEditorOptions {
  /**
   * The workflow's vars defaults, or undefined when this editor cannot know
   * them (e.g. a global-default retry prompt). Undefined turns the lint off
   * and makes the hover generic.
   */
  getVars: () => Readonly<Record<string, unknown>> | undefined;
  /** Ctrl/Cmd+click on a variable. */
  revealVariable?: (name: string) => void;
  /** Backs the lint's "add to workflow vars" quick fix; omitted → no fix. */
  defineVariable?: (name: string) => void;
  /** Extra lint refresh trigger for non-document inputs such as the vars. */
  needsRefresh?: (update: ViewUpdate) => boolean;
}

const VARIABLE_CLASS = "cm-workflow-var";
const VARIABLE_BRACE_CLASS = "cm-workflow-var-brace";
const VARIABLE_NAME_ATTRIBUTE = "data-variable-name";
const HOVER_VALUE_MAX_CHARS = 120;

const braceMark = Decoration.mark({ class: VARIABLE_BRACE_CLASS });

/** The substitutable placeholders: fenced ones are literal and stay plain. */
function findSubstitutablePlaceholders(text: string): VariablePlaceholder[] {
  return findVariablePlaceholders(text).filter(
    (placeholder) => !placeholder.inFence
  );
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const { from, to, name } of findSubstitutablePlaceholders(
    view.state.doc.toString()
  )) {
    ranges.push(
      Decoration.mark({
        class: VARIABLE_CLASS,
        attributes: { [VARIABLE_NAME_ATTRIBUTE]: name },
      }).range(from, to),
      braceMark.range(from, from + VARIABLE_PLACEHOLDER_DELIMITER_LENGTH),
      braceMark.range(to - VARIABLE_PLACEHOLDER_DELIMITER_LENGTH, to)
    );
  }
  return Decoration.set(ranges, true);
}

function createVariableDecorationExtension(): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );
}

function formatHoverValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > HOVER_VALUE_MAX_CHARS
    ? `"${text.slice(0, HOVER_VALUE_MAX_CHARS)}…"`
    : `"${text}"`;
}

function createVariableHoverExtension(
  options: WorkflowVariableEditorOptions
): Extension {
  return hoverTooltip(
    (view, pos) => {
      const placeholder = findSubstitutablePlaceholders(
        view.state.doc.toString()
      ).find(({ from, to }) => pos >= from && pos <= to);
      if (!placeholder) return null;
      const vars = options.getVars();
      // An undefined variable already has the lint tooltip; a second hover
      // saying the same thing would only stack beneath it.
      if (vars && !isVariableDefined(vars, placeholder.name)) return null;
      return {
        pos: placeholder.from,
        end: placeholder.to,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-workflow-var-tooltip";
          const name = document.createElement("span");
          name.className = VARIABLE_CLASS;
          name.textContent = placeholder.name;
          dom.appendChild(name);
          dom.append(
            vars
              ? ` = ${formatHoverValue(vars[placeholder.name])}`
              : " — workflow variable"
          );
          const hint = document.createElement("div");
          hint.className = "cm-workflow-var-tooltip-hint";
          hint.textContent = vars
            ? options.revealVariable
              ? "Workflow variable · Ctrl/Cmd+click to edit"
              : "Workflow variable"
            : `Replaced at run time by the workflow's vars or --var ${placeholder.name}=<value>`;
          dom.appendChild(hint);
          return { dom };
        },
      };
    },
    { hoverTime: 300 }
  );
}

function createVariableLintExtension(
  options: WorkflowVariableEditorOptions
): Extension {
  return linter(
    (view): Diagnostic[] => {
      const vars = options.getVars();
      if (!vars) return [];
      return getUndefinedVariableDiagnostics(
        view.state.doc.toString(),
        vars
      ).map((diagnostic) =>
        toCodeMirrorPromptDiagnostic(diagnostic, {
          defineVariable: options.defineVariable,
        })
      );
    },
    {
      delay: 300,
      needsRefresh: (update) =>
        update.docChanged || (options.needsRefresh?.(update) ?? false),
    }
  );
}

function createVariableClickExtension(
  revealVariable: (name: string) => void
): Extension {
  return EditorView.domEventHandlers({
    click: (event) => {
      // Like every text link: a plain click places the caret.
      if (!(event.ctrlKey || event.metaKey)) return false;
      const target =
        event.target instanceof Element
          ? event.target.closest(`[${VARIABLE_NAME_ATTRIBUTE}]`)
          : null;
      const name = target?.getAttribute(VARIABLE_NAME_ATTRIBUTE);
      if (!name) return false;
      event.preventDefault();
      revealVariable(name);
      return true;
    },
  });
}

function createVariableThemeExtension(): Extension {
  const color = SYMBOL_ICON_COLORS["symbol-variable"];
  return EditorView.baseTheme({
    [`.${VARIABLE_CLASS}`]: {
      color,
      fontWeight: "600",
      // Markdown emphasis can wrap a placeholder; keep the token uniform.
      fontStyle: "normal",
    },
    [`.${VARIABLE_BRACE_CLASS}`]: {
      fontWeight: "normal",
      opacity: "0.6",
    },
    ".cm-tooltip.cm-tooltip-hover:has(.cm-workflow-var-tooltip)": {
      backgroundColor:
        "var(--vscode-editorWidget-background, var(--vscode-editor-background))",
      border:
        "1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border))",
      boxShadow: "0 2px 8px var(--vscode-widget-shadow)",
      color:
        "var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground))",
    },
    ".cm-workflow-var-tooltip": {
      padding: "4px 8px",
      maxWidth: "420px",
      fontFamily: "var(--vscode-editor-font-family)",
      wordBreak: "break-word",
    },
    ".cm-workflow-var-tooltip-hint": {
      marginTop: "2px",
      fontFamily: "var(--vscode-font-family)",
      fontSize: "0.9em",
      opacity: "0.75",
    },
  });
}

export function createWorkflowVariableExtension(
  options: WorkflowVariableEditorOptions
): Extension {
  return [
    // Colour-bearing marks are Prec.highest so they draw inside markdown's
    // highlighting spans (Prec.high) and inside the inline-code mark — a
    // placeholder in backticks is substituted, so it must still read as one.
    Prec.highest(createVariableDecorationExtension()),
    createVariableHoverExtension(options),
    createVariableLintExtension(options),
    ...(options.revealVariable
      ? [createVariableClickExtension(options.revealVariable)]
      : []),
    createVariableThemeExtension(),
  ];
}
