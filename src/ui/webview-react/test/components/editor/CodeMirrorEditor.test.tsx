import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  buildCodeMirrorCompletionResult,
  buildPromptReferenceInsertion,
  createAtomicReferenceExtension,
  createClickHandlerExtension,
  destroyOrphanedMouseSelection,
  findContextReferenceMatches,
  findAtomicReferences,
  getRetryPlaceholderCompletions,
  type CodeMirrorEditorMode,
} from "@components/editor/CodeMirrorEditor";
import {
  MESSAGE_TYPES,
  PROMPT_EDITOR_INSERT_MODES,
  RETRY_PROMPT_PLACEHOLDERS,
} from "@/types/messages";
import { useUiStore } from "@store/uiStore";

function getCompletions(
  doc: string,
  mode: CodeMirrorEditorMode = "endCondition",
  explicit = false
) {
  return getRetryPlaceholderCompletions(
    {
      state: EditorState.create({ doc }),
      pos: doc.length,
      explicit,
    },
    mode
  );
}

describe("CodeMirrorEditor retry placeholder completions", () => {
  it("offers retry placeholders after an opening brace in endCondition mode", () => {
    const result = getCompletions("{");

    expect(result?.from).toBe(1);
    expect(result?.options.map((option) => option.label)).toContain(
      RETRY_PROMPT_PLACEHOLDERS.STDOUT
    );
    expect(result?.options.map((option) => option.label)).toContain(
      RETRY_PROMPT_PLACEHOLDERS.STDERR
    );
  });

  it("replaces only the text after the opening brace", () => {
    const result = getCompletions("Retry with {std");

    expect(result?.from).toBe("Retry with {".length);
    const stdout = result?.options.find(
      (option) => option.label === RETRY_PROMPT_PLACEHOLDERS.STDOUT
    );
    expect(stdout?.apply).toBe("stdout}");
  });

  it("does not offer retry placeholders in prompt mode", () => {
    expect(getCompletions("{", "prompt")).toBeNull();
  });

  it("does not trigger after whitespace or a closing brace", () => {
    expect(getCompletions("{std out")).toBeNull();
    expect(getCompletions("{stdout}")).toBeNull();
  });
});

describe("CodeMirrorEditor external reference completions", () => {
  it("disables CodeMirror filtering for @ completions when the query already includes a path", () => {
    const result = buildCodeMirrorCompletionResult(
      [
        {
          label: "CodeMirrorEditor.tsx",
          kind: 16,
          insertText:
            "src/ui/webview-react/components/editor/CodeMirrorEditor.tsx",
          sortText:
            "0_src/ui/webview-react/components/editor/CodeMirrorEditor.tsx",
        },
      ],
      12,
      {
        trigger: "@",
        query: "src/ui/webview-react/components/editor/Co",
      }
    );

    expect(result.from).toBe(13);
    expect(result.filter).toBe(false);
  });

  it("keeps CodeMirror fuzzy filtering for basename-only @ completions", () => {
    const result = buildCodeMirrorCompletionResult(
      [{ label: "CodeMirrorEditor.tsx", kind: 16, insertText: "src/file.ts" }],
      5,
      { trigger: "@", query: "Co" }
    );

    expect(result.from).toBe(6);
    expect(result.filter).toBeUndefined();
  });

  it("uses filterText for CodeMirror fuzzy matching while keeping the visible label", () => {
    const result = buildCodeMirrorCompletionResult(
      [
        {
          label: "CodeMirrorEditor.tsx",
          kind: 16,
          insertText: "src/file.ts",
          filterText:
            "CodeMirrorEditor.tsx src/ui/webview-react/components/editor/CodeMirrorEditor.tsx",
        },
      ],
      5,
      { trigger: "@", query: "cme" }
    );

    expect(result.options[0]?.label).toBe(
      "CodeMirrorEditor.tsx src/ui/webview-react/components/editor/CodeMirrorEditor.tsx"
    );
    expect(result.options[0]?.displayLabel).toBe("CodeMirrorEditor.tsx");
  });

  it("replaces the complete lone prompt path without adding a trigger offset", () => {
    const result = buildCodeMirrorCompletionResult(
      [
        {
          label: "current.prompt.md",
          kind: 16,
          insertText: "root2/prompts/current.prompt.md",
        },
      ],
      0,
      { trigger: "path", query: "root2/prompts/cu" }
    );

    expect(result.from).toBe(0);
    expect(result.filter).toBe(false);
    expect(result.options[0]?.apply).toBe("root2/prompts/current.prompt.md");
  });
});

describe("CodeMirrorEditor completion kind icons", () => {
  function typeFor(kind: number | undefined) {
    return buildCodeMirrorCompletionResult(
      [{ label: "x", kind, insertText: "x" }],
      0,
      { trigger: "#", query: "" }
    ).options[0]?.type;
  }

  it("maps symbol completion kinds to distinct symbol-* codicons", () => {
    expect(typeFor(1)).toBe("symbol-method"); // Method
    expect(typeFor(2)).toBe("symbol-function"); // Function
    expect(typeFor(6)).toBe("symbol-class"); // Class
    expect(typeFor(7)).toBe("symbol-interface"); // Interface
    expect(typeFor(21)).toBe("symbol-struct"); // Struct
  });

  it("gives the selection completion (Unit) its own icon, distinct from git completions (Reference)", () => {
    expect(typeFor(10)).toBe("list-selection");
    expect(typeFor(17)).toBe("source-control");
  });

  it("falls back to symbol-misc for an unknown or missing kind", () => {
    expect(typeFor(999)).toBe("symbol-misc");
    expect(typeFor(undefined)).toBe("symbol-misc");
  });
});

describe("CodeMirrorEditor symbol completion icon cache seeding", () => {
  // The completion item's kind is known synchronously at pick time; picking it
  // should seed the chip icon cache immediately instead of waiting on the
  // debounced round trip in createContextReferenceLintExtension, so the chip
  // never has to show DEFAULT_COMPLETION_ICON first and flash to the real
  // icon later. See symbolIconCacheKey for the cache key format.
  function pickSymbolCompletion(
    cache: Map<string, string>,
    insertText: string,
    kind: number
  ) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ parent, doc: "" });

    const result = buildCodeMirrorCompletionResult(
      [{ label: "MySymbol", kind, insertText }],
      0,
      { trigger: "#", query: "" },
      cache
    );
    const completion = result.options[0];
    const apply = completion.apply as (
      view: EditorView,
      completion: unknown,
      from: number,
      to: number
    ) => void;
    apply(view, completion, 0, 0);

    const docText = view.state.doc.toString();
    view.destroy();
    return docText;
  }

  it("seeds the cache with the completion's own icon on pick", () => {
    const cache = new Map<string, string>();

    // Production insertText has no leading `#` (the `#` trigger stays in the
    // doc at `from`); the seed reconstructs `#` + insertText before parsing, so
    // this must still resolve the symbol kind. Before that reconstruction the
    // parse silently no-op'd and the chip flashed the misc icon.
    const docText = pickSymbolCompletion(
      cache,
      "sym:src/a.ts:MyClass:10-20",
      6 // Class
    );

    // Terminal reference → self-terminating trailing space (see
    // withReferenceBoundarySpace). The seeded cache key is unaffected.
    expect(docText).toBe("sym:src/a.ts:MyClass:10-20 ");
    expect(cache.get("src/a.ts::MyClass::10-20")).toBe("symbol-class");
  });

  it("does not seed the cache when no cache is supplied", () => {
    const result = buildCodeMirrorCompletionResult(
      [
        {
          label: "MyClass",
          kind: 6,
          insertText: "sym:src/a.ts:MyClass:10-20",
        },
      ],
      0,
      { trigger: "#", query: "" }
    );

    expect(result.options[0].apply).toBe("sym:src/a.ts:MyClass:10-20 ");
  });

  it("does not seed the cache for non-symbol completions even with a kind", () => {
    const cache = new Map<string, string>();

    const result = buildCodeMirrorCompletionResult(
      [{ label: "foo.ts", kind: 16, insertText: "foo.ts" }],
      0,
      { trigger: "@", query: "" },
      cache
    );

    expect(result.options[0].apply).toBe("foo.ts ");
    expect(cache.size).toBe(0);
  });
});

describe("CodeMirrorEditor completion boundary space", () => {
  // A terminal reference gets a trailing space on pick so appended text can't
  // merge into it (and, in atomic mode, get absorbed into the chip). "Keep
  // typing" completions (directories, "$step:") and the whole-prompt path
  // trigger are exempt so progressive completion / file loading still works.
  function applyFor(
    insertText: string,
    trigger: "@" | "#" | "~" | "$" | "path"
  ) {
    return buildCodeMirrorCompletionResult([{ label: "x", insertText }], 0, {
      trigger,
      query: "",
    }).options[0].apply;
  }

  it("appends a trailing space to terminal @file / #selection / ~git references", () => {
    expect(applyFor("src/app.ts", "@")).toBe("src/app.ts ");
    expect(applyFor('"path with spaces/a.ts"', "@")).toBe(
      '"path with spaces/a.ts" '
    );
    expect(applyFor("selection:src/a.ts:10-20", "#")).toBe(
      "selection:src/a.ts:10-20 "
    );
    expect(applyFor("diff", "~")).toBe("diff ");
    expect(applyFor("previous", "$")).toBe("previous ");
  });

  it("leaves directory completions unterminated so sub-folder drilling continues", () => {
    expect(applyFor("src/ui/", "@")).toBe("src/ui/");
    expect(applyFor('"path with spaces/"', "@")).toBe('"path with spaces/"');
  });

  it("leaves colon-continuation tokens ($step:) unterminated", () => {
    expect(applyFor("step:", "$")).toBe("step:");
  });

  it("does not add a space for the whole-prompt path trigger", () => {
    expect(applyFor("prompts/current.prompt.md", "path")).toBe(
      "prompts/current.prompt.md"
    );
  });
});

describe("CodeMirrorEditor prompt reference insertion", () => {
  it("surrounds multi-reference inserts with newlines when inserting mid-line", () => {
    const result = buildPromptReferenceInsertion(
      "Review this prompt",
      {
        requestId: "insert-1",
        references: ["@src/app.ts", "@package.json"],
        mode: PROMPT_EDITOR_INSERT_MODES.INSERT,
      },
      { from: "Review".length, to: "Review".length }
    );

    expect(result).toEqual({
      from: "Review".length,
      to: "Review".length,
      text: "\n@src/app.ts\n@package.json\n",
    });
  });

  it("appends references at the end of the document in append mode", () => {
    const result = buildPromptReferenceInsertion(
      "Analyze current output",
      {
        requestId: "insert-2",
        references: ["@src/extension.ts"],
        mode: PROMPT_EDITOR_INSERT_MODES.APPEND,
      },
      { from: 0, to: 0 }
    );

    expect(result).toEqual({
      from: "Analyze current output".length,
      to: "Analyze current output".length,
      text: "\n@src/extension.ts",
    });
  });
});

describe("CodeMirrorEditor orphaned mouse-selection guard", () => {
  it("tears down a lingering MouseSelection (the stuck-caret orphan)", () => {
    const destroy = vi.fn();
    const view = {
      inputState: { mouseSelection: { destroy } },
    } as unknown as EditorView;

    destroyOrphanedMouseSelection(view);

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (and does not throw) when there is no active mouse selection", () => {
    expect(() =>
      destroyOrphanedMouseSelection({
        inputState: { mouseSelection: null },
      } as unknown as EditorView)
    ).not.toThrow();

    // Also tolerate a future CodeMirror that drops/renames inputState entirely.
    expect(() =>
      destroyOrphanedMouseSelection({} as unknown as EditorView)
    ).not.toThrow();
  });
});

describe("CodeMirrorEditor context reference parsing", () => {
  it("treats a dotted path with a trailing slash only as a directory", () => {
    expect(findContextReferenceMatches("@.ctrlyoke/.runs/")).toEqual([
      {
        from: 0,
        to: "@.ctrlyoke/.runs/".length,
        type: "directory",
        path: ".ctrlyoke/.runs/",
      },
    ]);
  });

  it("still recognizes file paths with alphanumeric extensions", () => {
    expect(findContextReferenceMatches("Review @src/file.ts.")).toEqual([
      {
        from: "Review ".length,
        to: "Review @src/file.ts".length,
        type: "file",
        path: "src/file.ts",
      },
    ]);
  });
});

describe("CodeMirrorEditor atomic reference chips", () => {
  it("opens on a plain click without starting a CodeMirror mouse selection", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const postMessage = vi.fn();
    const view = new EditorView({
      parent,
      doc: "@src/deep/file.ts",
      extensions: [
        createAtomicReferenceExtension(),
        createClickHandlerExtension({ postMessage }, { current: 2 }),
      ],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip).not.toBeNull();

      chip?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 })
      );
      const inputState = view as unknown as {
        inputState: { mouseSelection: unknown };
      };
      expect(inputState.inputState.mouseSelection).toBeNull();

      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      chip?.dispatchEvent(click);

      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.OPEN_FILE,
        path: "src/deep/file.ts",
      });
      expect(click.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(view.contentDOM);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("refuses to open a chip the validation pass marked invalid and warns instead of posting OPEN_FILE", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const postMessage = vi.fn();
    const toastSpy = vi.spyOn(useUiStore.getState(), "showToast");
    const validity = new Map<string, boolean>([["@b/missing.ts", false]]);
    const view = new EditorView({
      parent,
      doc: "@b/missing.ts",
      extensions: [
        createAtomicReferenceExtension(new Map(), validity),
        createClickHandlerExtension({ postMessage }, { current: 0 }),
      ],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      // Flagged for the click handler...
      expect(chip?.getAttribute("data-invalid")).toBe("true");

      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      chip?.dispatchEvent(click);

      // ...so the click is consumed with a warning, never an open attempt.
      expect(postMessage).not.toHaveBeenCalled();
      expect(toastSpy).toHaveBeenCalledOnce();
      expect(click.defaultPrevented).toBe(true);
    } finally {
      toastSpy.mockRestore();
      view.destroy();
      parent.remove();
    }
  });

  it("labels a file reference with just its basename and keeps the full text as title", () => {
    const doc = "See @src/deep/file.ts";
    expect(findAtomicReferences(doc)).toEqual([
      {
        from: "See ".length,
        to: doc.length,
        icon: "symbol-file",
        label: "file.ts",
        title: "@src/deep/file.ts",
        attrs: { "data-type": "file", "data-path": "src/deep/file.ts" },
      },
    ]);
  });

  it("labels a directory with a trailing slash", () => {
    const chips = findAtomicReferences("@src/deep/");
    expect(chips[0]).toMatchObject({
      icon: "folder",
      label: "deep/",
      attrs: { "data-type": "directory", "data-path": "src/deep/" },
    });
  });

  it("labels a symbol with its symbol name", () => {
    const chips = findAtomicReferences("#sym:src/a.ts:MyClass:10-20");
    expect(chips[0]).toMatchObject({
      label: "MyClass",
      attrs: {
        "data-type": "symbol",
        "data-path": "src/a.ts",
        "data-symbol-name": "MyClass",
        "data-line-start": "10",
        "data-line-end": "20",
      },
    });
  });

  it("falls back to a generic symbol icon when the kind hasn't resolved yet", () => {
    const chips = findAtomicReferences("#sym:src/a.ts:MyClass:10-20");
    expect(chips[0]).toMatchObject({ icon: "symbol-misc" });
  });

  it("uses the resolved codicon once the symbol's kind is cached", () => {
    const chips = findAtomicReferences(
      "#sym:src/a.ts:MyClass:10-20",
      (path, symbolName, lineStart, lineEnd) =>
        path === "src/a.ts" &&
        symbolName === "MyClass" &&
        lineStart === "10" &&
        lineEnd === "20"
          ? "symbol-class"
          : undefined
    );
    expect(chips[0]).toMatchObject({ icon: "symbol-class" });
  });

  it("labels a line-range selection with basename and lines", () => {
    const chips = findAtomicReferences("#selection:src/a.ts:10-20");
    expect(chips[0]).toMatchObject({ label: "a.ts:10-20" });
  });

  it("shortens a git commit hash but keeps keyword refs as-is", () => {
    expect(findAtomicReferences("~diff")[0]).toMatchObject({
      label: "diff",
      attrs: { "data-type": "git", "data-git-ref": "diff" },
    });
    const hash = "0123456789abcdef0123456789abcdef01234567";
    expect(findAtomicReferences(`~${hash}`)[0]).toMatchObject({
      label: "0123456",
      attrs: { "data-type": "git", "data-git-ref": hash },
    });
  });

  it("labels a $ prior-context reference", () => {
    const chips = findAtomicReferences("Use $previous here");
    expect(chips).toEqual([
      {
        from: "Use ".length,
        to: "Use $previous".length,
        icon: "book",
        label: "previous",
        title: "$previous",
        attrs: { "data-type": "priorContext", "data-ref": "previous" },
      },
    ]);
  });

  it("labels a $step range reference", () => {
    const chips = findAtomicReferences("$step:1,3-4");
    expect(chips[0]).toMatchObject({
      label: "step 1,3,4",
      attrs: { "data-type": "priorContext", "data-ref": "step:1,3,4" },
    });
  });

  it("returns multiple references sorted by start", () => {
    const chips = findAtomicReferences("@a/one.ts and @b/two.ts");
    expect(chips.map((c) => [c.from, c.to])).toEqual([
      [0, "@a/one.ts".length],
      ["@a/one.ts and ".length, "@a/one.ts and @b/two.ts".length],
    ]);
  });

  it("excludes references inside fenced blocks", () => {
    expect(findAtomicReferences("```\n@src/file.ts\n```")).toEqual([]);
  });

  it("excludes a lone prompt-path prompt (no trigger character)", () => {
    expect(
      findAtomicReferences("./src/completions/CompletionHelpers.ts")
    ).toEqual([]);
  });

  it("absorbs a $token that overlaps an enclosing @path reference", () => {
    // `$previous` sits inside the `@…$previous.ts` file match; the wider @ range
    // must win so the RangeSet stays non-overlapping.
    const doc = "@foo$previous.ts";
    const chips = findAtomicReferences(doc);
    expect(chips.map((c) => [c.from, c.to])).toEqual([[0, doc.length]]);
  });

  it("flags a chip invalid only when validation resolved the token as not-found", () => {
    const doc = "@a/valid.ts and @b/missing.ts and @c/pending.ts";
    // Validation resolved two of the three tokens; the third is still unknown.
    const validity = new Map<string, boolean>([
      ["@a/valid.ts", true],
      ["@b/missing.ts", false],
    ]);
    const chips = findAtomicReferences(doc, undefined, (token) =>
      validity.get(token)
    );
    // undefined (not the literal false) while resolvable or unvalidated, so no
    // border shows before the debounced pass or for a good reference.
    expect(chips.map((c) => c.invalid)).toEqual([undefined, true, undefined]);
  });

  it("leaves the invalid flag undefined when no validity resolver is supplied", () => {
    expect(findAtomicReferences("@b/missing.ts")[0].invalid).toBeUndefined();
  });

  it("renders the warning border class on an unresolvable reference chip", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const validity = new Map<string, boolean>([["@b/missing.ts", false]]);
    const view = new EditorView({
      parent,
      doc: "@b/missing.ts",
      extensions: [createAtomicReferenceExtension(new Map(), validity)],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip?.classList.contains("cm-atomic-ref-invalid")).toBe(true);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("does not mark a resolvable reference chip with the warning border class", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const validity = new Map<string, boolean>([["@a/valid.ts", true]]);
    const view = new EditorView({
      parent,
      doc: "@a/valid.ts",
      extensions: [createAtomicReferenceExtension(new Map(), validity)],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip?.classList.contains("cm-atomic-ref-invalid")).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("suppresses the native hover title on an unresolvable reference chip so it doesn't fight the lint tooltip", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const validity = new Map<string, boolean>([["@b/missing.ts", false]]);
    const view = new EditorView({
      parent,
      doc: "@b/missing.ts",
      extensions: [createAtomicReferenceExtension(new Map(), validity)],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip?.hasAttribute("title")).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("keeps the native hover title on a resolvable reference chip", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const validity = new Map<string, boolean>([["@a/valid.ts", true]]);
    const view = new EditorView({
      parent,
      doc: "@a/valid.ts",
      extensions: [createAtomicReferenceExtension(new Map(), validity)],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip?.title).toBe("@a/valid.ts");
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
