import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";
import { relintForContextChange } from "@utils/codemirrorRelint";
import {
  createSpellCheckExtension,
  splitCamelCaseWord,
  type SpellCheckExtensionOptions,
} from "@utils/codemirrorSpellCheck";
import { SpellCheckService, type TypoChecker } from "@utils/spellChecker";
import { SETTING_SCOPES } from "@root/types/DashboardConstants";

const KNOWN_WORDS = new Set(["the", "is", "spelled", "word", "Yoke", "café"]);

class FakeTypo implements TypoChecker {
  check = (word: string) => KNOWN_WORDS.has(word);
  suggest = (word: string) => (word === "wrod" ? ["word"] : []);
}

const views: EditorView[] = [];

async function createLoadedChecker(): Promise<SpellCheckService> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(""))
  );
  vi.stubGlobal("Typo", FakeTypo);
  const checker = new SpellCheckService();
  checker.ensureLoaded("a.aff", "a.dic");
  await vi.waitFor(() => expect(checker.isReady()).toBe(true));
  return checker;
}

function createView(
  doc: string,
  overrides: Partial<SpellCheckExtensionOptions> & {
    checker: SpellCheckService;
  }
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    doc,
    extensions: [
      createSpellCheckExtension({
        allowWorkspaceFolderPrefix: false,
        isEnabled: () => true,
        hasWorkspace: () => true,
        onAddWord: () => {},
        ...overrides,
      }),
    ],
  });
  views.push(view);
  return view;
}

async function lint(view: EditorView) {
  relintForContextChange(view);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const diagnostics: Array<{ text: string; actions: string[] }> = [];
  forEachDiagnostic(view.state, (diagnostic, from, to) => {
    diagnostics.push({
      text: view.state.sliceDoc(from, to),
      actions: (diagnostic.actions ?? []).map((action) => action.name),
    });
  });
  return diagnostics;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
  vi.unstubAllGlobals();
});

describe("prompt spell check extension", () => {
  it("offers Add to dictionary for a word with no suggestions", async () => {
    const checker = await createLoadedChecker();
    const onAddWord = vi.fn();
    const view = createView("the ctrlyoke word", { checker, onAddWord });

    expect(await lint(view)).toEqual([
      {
        text: "ctrlyoke",
        actions: [
          'Add "ctrlyoke" to dictionary',
          'Add "ctrlyoke" to workspace dictionary',
        ],
      },
    ]);

    forEachDiagnostic(view.state, (diagnostic, from, to) => {
      diagnostic.actions?.[1]?.apply(view, from, to);
    });
    expect(onAddWord).toHaveBeenCalledWith(
      "ctrlyoke",
      SETTING_SCOPES.WORKSPACE
    );
    // Adding a word never edits the prompt text.
    expect(view.state.doc.toString()).toBe("the ctrlyoke word");
  });

  it("lists Change to fixes first and hides the workspace fix without a workspace", async () => {
    const checker = await createLoadedChecker();
    const view = createView("the wrod", {
      checker,
      hasWorkspace: () => false,
    });

    expect(await lint(view)).toEqual([
      {
        text: "wrod",
        actions: ['Change to "word"', 'Add "wrod" to dictionary'],
      },
    ]);
  });

  it("clears the squiggle once the word is added, without an edit", async () => {
    const checker = await createLoadedChecker();
    const view = createView("the ctrlyoke word", { checker });
    expect(await lint(view)).toHaveLength(1);

    checker.addWordLocally("ctrlyoke");
    expect(await lint(view)).toEqual([]);
  });

  it("matches a custom camelCase word whole, before splitting it", async () => {
    const checker = await createLoadedChecker();
    const view = createView("the CtrlYoke word", { checker });
    expect((await lint(view)).map((d) => d.text)).toEqual(["Ctrl"]);

    checker.setCustomWords(["CtrlYoke"]);
    expect(await lint(view)).toEqual([]);
  });

  it("keeps accented words whole", async () => {
    const checker = await createLoadedChecker();
    const view = createView("the café is spelled", { checker });
    expect(await lint(view)).toEqual([]);
  });

  it("reports nothing while spell check is off", async () => {
    const checker = await createLoadedChecker();
    const view = createView("the ctrlyoke word", {
      checker,
      isEnabled: () => false,
    });
    expect(await lint(view)).toEqual([]);
  });
});

describe("splitCamelCaseWord", () => {
  it("splits at case changes, including non-ASCII letters", () => {
    expect(splitCamelCaseWord("XMLParser")).toEqual([
      { text: "XML", offset: 0 },
      { text: "Parser", offset: 3 },
    ]);
    expect(splitCamelCaseWord("überÄrger")).toEqual([
      { text: "über", offset: 0 },
      { text: "Ärger", offset: 4 },
    ]);
    expect(splitCamelCaseWord("don't")).toEqual([{ text: "don't", offset: 0 }]);
  });
});
