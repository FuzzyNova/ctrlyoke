import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import { forEachDiagnostic, forceLinting } from "@codemirror/lint";
import {
  createWorkflowVariableExtension,
  type WorkflowVariableEditorOptions,
} from "@utils/codemirrorWorkflowVariables";

const views: EditorView[] = [];

function createView(
  doc: string,
  options: WorkflowVariableEditorOptions
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    doc,
    extensions: [createWorkflowVariableExtension(options)],
  });
  views.push(view);
  return view;
}

async function lint(view: EditorView) {
  forceLinting(view);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const diagnostics: Array<{
    text: string;
    severity: string;
    actions: string[];
  }> = [];
  forEachDiagnostic(view.state, (diagnostic, from, to) => {
    diagnostics.push({
      text: view.state.sliceDoc(from, to),
      severity: diagnostic.severity,
      actions: (diagnostic.actions ?? []).map((action) => action.name),
    });
  });
  return diagnostics;
}

function styledNames(view: EditorView): string[] {
  return [...view.dom.querySelectorAll<HTMLElement>(".cm-workflow-var")].map(
    (element) => element.textContent ?? ""
  );
}

afterEach(() => {
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
});

describe("workflow variable editor extension", () => {
  it("styles placeholders, including ones in inline code, but not fenced ones", () => {
    // Inline code does not protect a placeholder at run time, so it must look
    // like a variable; a fenced one stays literal and must look like text.
    const view = createView("Hi {{name}} `{{inline}}`\n```\n{{fenced}}\n```", {
      getVars: () => ({}),
    });
    expect(styledNames(view)).toEqual(["{{name}}", "{{inline}}"]);
    expect(
      [...view.dom.querySelectorAll(".cm-workflow-var-brace")].map(
        (element) => element.textContent
      )
    ).toEqual(["{{", "}}", "{{", "}}"]);
  });

  it("warns on an undefined variable and offers to add it to the vars", async () => {
    const defineVariable = vi.fn();
    const view = createView("{{known}} {{testvar}}", {
      getVars: () => ({ known: "x" }),
      defineVariable,
    });

    const diagnostics = await lint(view);
    expect(diagnostics).toEqual([
      {
        text: "{{testvar}}",
        severity: "warning",
        actions: ['Add "testvar" to workflow vars'],
      },
    ]);

    forEachDiagnostic(view.state, (diagnostic, from, to) => {
      diagnostic.actions?.[0]?.apply(view, from, to);
    });
    expect(defineVariable).toHaveBeenCalledWith("testvar");
    // The fix edits the workflow, never the prompt text.
    expect(view.state.doc.toString()).toBe("{{known}} {{testvar}}");
  });

  it("offers no quick fix without a define handler", async () => {
    const view = createView("{{testvar}}", { getVars: () => ({}) });
    expect((await lint(view))[0]?.actions).toEqual([]);
  });

  it("does not lint when the editor cannot know the vars", async () => {
    const view = createView("{{testvar}}", { getVars: () => undefined });
    expect(await lint(view)).toEqual([]);
    expect(styledNames(view)).toEqual(["{{testvar}}"]);
  });

  it("re-lints when the vars change without a document edit", async () => {
    const varsChanged = StateEffect.define<void>();
    let vars: Record<string, string> = {};
    const view = createView("{{testvar}}", {
      getVars: () => vars,
      needsRefresh: (update) =>
        update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(varsChanged))
        ),
    });
    expect(await lint(view)).toHaveLength(1);

    vars = { testvar: "value" };
    view.dispatch({ effects: varsChanged.of(undefined) });
    expect(await lint(view)).toEqual([]);
  });

  it("reveals a variable on Ctrl/Cmd+click, not on a plain click", () => {
    const revealVariable = vi.fn();
    const view = createView("Use {{region}} here", {
      getVars: () => ({ region: "us" }),
      revealVariable,
    });
    const token = view.dom.querySelector<HTMLElement>(".cm-workflow-var-brace");
    expect(token).not.toBeNull();

    token!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(revealVariable).not.toHaveBeenCalled();

    token!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, ctrlKey: true })
    );
    expect(revealVariable).toHaveBeenCalledWith("region");
  });
});
