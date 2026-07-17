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
    expect(findContextReferenceMatches("@.ctrlyoke/.history/")).toEqual([
      {
        from: 0,
        to: "@.ctrlyoke/.history/".length,
        type: "directory",
        path: ".ctrlyoke/.history/",
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
});
