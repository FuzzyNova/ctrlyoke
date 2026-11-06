import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { getHarnessShellEscapeDiagnostics } from "@root/utils/PromptDiagnosticRules";
import { toCodeMirrorPromptDiagnostic } from "@utils/promptDiagnosticCodeMirror";
import { useEditorStore } from "@store/editorStore";
import { STEP_TYPES } from "@root/types/DashboardConstants";

const views: EditorView[] = [];

function makeView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ parent, doc });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
  useEditorStore.getState().resetEditor();
});

describe("prompt diagnostic CodeMirror actions", () => {
  it("converts a shell escape to a script step and restores the prompt on switch-back", () => {
    const originalPrompt = "  !  npm run test  ";
    const editor = useEditorStore.getState();
    editor.setPromptText(originalPrompt);
    const view = makeView(originalPrompt);
    const [sharedDiagnostic] = getHarnessShellEscapeDiagnostics(originalPrompt);
    const convert = vi.fn((command: string) => {
      useEditorStore.getState().setStepType(STEP_TYPES.SCRIPT);
      useEditorStore.getState().setScriptCommand(command);
    });
    const diagnostic = toCodeMirrorPromptDiagnostic(sharedDiagnostic, {
      convertShellEscapeToScript: convert,
    });

    diagnostic.actions?.[0]?.apply?.(view, diagnostic.from, diagnostic.to);

    expect(diagnostic.actions?.map((action) => action.name)).toEqual([
      "Convert to script step",
      'Remove "!"',
    ]);
    expect(convert).toHaveBeenCalledWith("npm run test");
    expect(useEditorStore.getState().stepType).toBe(STEP_TYPES.SCRIPT);
    expect(useEditorStore.getState().scriptCommand).toBe("npm run test");

    useEditorStore.getState().setStepType(STEP_TYPES.PROMPT);
    expect(useEditorStore.getState().promptText).toBe(originalPrompt);
  });

  it('removes "!" and the whitespace after it while preserving earlier text spacing', () => {
    const text = "  !  npm run test";
    const view = makeView(text);
    const [sharedDiagnostic] = getHarnessShellEscapeDiagnostics(text);
    const diagnostic = toCodeMirrorPromptDiagnostic(sharedDiagnostic);

    diagnostic.actions?.[0]?.apply?.(view, diagnostic.from, diagnostic.to);

    expect(diagnostic.actions?.map((action) => action.name)).toEqual([
      'Remove "!"',
    ]);
    expect(view.state.doc.toString()).toBe("  npm run test");
  });
});
