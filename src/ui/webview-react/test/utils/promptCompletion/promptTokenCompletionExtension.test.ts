import { describe, expect, it } from "vitest";
import {
  CompletionContext,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { promptTokenLanguageDataExtension } from "@utils/promptCompletion/promptTokenCompletionExtension";

describe("promptTokenLanguageDataExtension", () => {
  const source: CompletionSource = () => ({
    from: 0,
    options: [{ label: "item" }],
  });

  function sourcesAt(state: EditorState): readonly CompletionSource[] {
    return state.languageDataAt<CompletionSource>("autocomplete", 0);
  }

  it("registers each source as autocomplete language data", () => {
    const state = EditorState.create({
      doc: "@",
      extensions: promptTokenLanguageDataExtension({ sources: [source] }),
    });
    const [registered] = sourcesAt(state);
    expect(registered(new CompletionContext(state, 1, true))).toMatchObject({
      options: [{ label: "item" }],
    });
  });

  it("skips sources where the gate rejects the position", () => {
    const state = EditorState.create({
      doc: "@",
      extensions: promptTokenLanguageDataExtension({
        sources: [source],
        gate: (context) => context.pos > 5,
      }),
    });
    const [registered] = sourcesAt(state);
    expect(registered(new CompletionContext(state, 1, true))).toBeNull();
  });
});
