import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  buildCodeMirrorCompletionResult,
  buildPromptReferenceInsertion,
  destroyOrphanedMouseSelection,
  findContextReferenceMatches,
  findReferenceAtBoundary,
  getRetryPlaceholderCompletions,
  type CodeMirrorEditorMode,
} from "@components/editor/CodeMirrorEditor";
import {
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

describe("CodeMirrorEditor reference-boundary detection", () => {
  it("finds a file reference when the caret is at its end (Backspace)", () => {
    const doc = "See @src/file.ts";
    expect(findReferenceAtBoundary(doc, doc.length, "end")).toEqual({
      from: "See ".length,
      to: doc.length,
    });
  });

  it("finds a file reference when the caret is at its start (Delete)", () => {
    const doc = "See @src/file.ts";
    expect(findReferenceAtBoundary(doc, "See ".length, "start")).toEqual({
      from: "See ".length,
      to: doc.length,
    });
  });

  it("returns null when the caret is in the middle of a reference", () => {
    const doc = "@src/file.ts";
    expect(findReferenceAtBoundary(doc, 5, "end")).toBeNull();
  });

  it("does not match the end edge when the caret is at the start", () => {
    const doc = "See @src/file.ts";
    expect(findReferenceAtBoundary(doc, "See ".length, "end")).toBeNull();
  });

  it("detects $ prior-context references at their end", () => {
    const doc = "Use $previous";
    expect(findReferenceAtBoundary(doc, doc.length, "end")).toEqual({
      from: "Use ".length,
      to: doc.length,
    });
  });

  it("ignores references inside fenced blocks", () => {
    const doc = "```\n@src/file.ts\n```";
    const end = "```\n@src/file.ts".length;
    expect(findReferenceAtBoundary(doc, end, "end")).toBeNull();
  });

  it("does not match a lone prompt-path prompt (no trigger character)", () => {
    const doc = "./src/completions/CompletionHelpers.ts";
    expect(findReferenceAtBoundary(doc, doc.length, "end")).toBeNull();
  });
});
