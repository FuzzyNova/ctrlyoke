import { describe, expect, it, vi } from "vitest";
import type { Completion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { buildCodeMirrorCompletionResult } from "@utils/promptCompletion/promptCompletionResult";

describe("buildCodeMirrorCompletionResult", () => {
  it("keeps status rows non-insertable when picked", () => {
    const result = buildCodeMirrorCompletionResult(
      [{ label: "Indexing workspace files… (42 so far)", status: true }],
      0,
      { trigger: "@", query: "" }
    );
    const option = result.options[0];
    const dispatch = vi.fn();

    expect(option.label).toBe("Indexing workspace files… (42 so far)");
    expect(typeof option.apply).toBe("function");
    if (typeof option.apply !== "function") {
      throw new Error("Expected status completion to have a no-op apply handler");
    }
    option.apply(
      { dispatch } as unknown as EditorView,
      option as Completion,
      result.from,
      result.from
    );

    expect(dispatch).not.toHaveBeenCalled();
  });
});
