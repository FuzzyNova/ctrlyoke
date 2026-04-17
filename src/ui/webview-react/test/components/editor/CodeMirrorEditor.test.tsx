import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  getRetryPlaceholderCompletions,
  type CodeMirrorEditorMode,
} from "@components/editor/CodeMirrorEditor";
import { RETRY_PROMPT_PLACEHOLDERS } from "@/types/messages";

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
