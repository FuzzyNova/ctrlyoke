import type { Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { PromptDiagnostic } from "@root/utils/PromptDiagnosticRules";

/** Maps shared prompt lint output to the prompt editor's tooltip and actions. */
export function toCodeMirrorPromptDiagnostic(
  diagnostic: PromptDiagnostic
): Diagnostic {
  const { detail, replacements } = diagnostic;
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
    ...(replacements?.length
      ? {
          actions: replacements.map((replacement) => ({
            name: `Change to ${replacement}`,
            apply: (view: EditorView, from: number, to: number) => {
              view.dispatch({ changes: { from, to, insert: replacement } });
            },
          })),
        }
      : {}),
  };
}
