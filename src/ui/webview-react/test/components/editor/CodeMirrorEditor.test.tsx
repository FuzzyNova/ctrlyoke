import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  buildPromptReferenceInsertion,
  findContextReferenceMatches,
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

describe("CodeMirrorEditor context reference parsing", () => {
  it("treats a dotted path with a trailing slash only as a directory", () => {
    expect(findContextReferenceMatches("@.flightpath/.history/")).toEqual([
      {
        from: 0,
        to: "@.flightpath/.history/".length,
        type: "directory",
        path: ".flightpath/.history/",
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
