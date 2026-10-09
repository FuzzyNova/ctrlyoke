import type { Action, Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { PromptDiagnostic } from "@root/utils/PromptDiagnosticRules";

/** Host actions a diagnostic can offer beyond text replacement. */
export interface PromptDiagnosticActionOptions {
  /** Adds an undefined variable to the workflow's vars. */
  defineVariable?: (name: string) => void;
}

/** Maps shared prompt lint output to the prompt editor's tooltip and actions. */
export function toCodeMirrorPromptDiagnostic(
  diagnostic: PromptDiagnostic,
  options: PromptDiagnosticActionOptions = {}
): Diagnostic {
  const { detail, replacements, variableName } = diagnostic;
  const { defineVariable } = options;
  const actions: Action[] = [
    ...(replacements ?? []).map((replacement) => ({
      name: `Change to ${replacement}`,
      apply: (view: EditorView, from: number, to: number) => {
        view.dispatch({ changes: { from, to, insert: replacement } });
      },
    })),
    ...(variableName && defineVariable
      ? [
          {
            name: `Add "${variableName}" to workflow vars`,
            apply: () => defineVariable(variableName),
          },
        ]
      : []),
  ];
  return {
    from: diagnostic.from,
    to: diagnostic.to,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(detail
      ? {
          renderMessage: () => {
            const fragment = document.createDocumentFragment();
            fragment.append(diagnostic.message);
            const pathLine = document.createElement("span");
            pathLine.className = "cm-reference-lint-path";
            pathLine.textContent = detail;
            fragment.appendChild(pathLine);
            return fragment;
          },
        }
      : {}),
    ...(actions.length ? { actions } : {}),
  };
}
