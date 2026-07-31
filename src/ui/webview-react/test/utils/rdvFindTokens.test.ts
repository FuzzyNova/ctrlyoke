import { describe, it, expect } from "vitest";
import type { HunkTokens, TokenNode } from "react-diff-view";
import { markFindTokens } from "@utils/rdvFindTokens";

function tokens(old: TokenNode[][], next: TokenNode[][]): HunkTokens {
  return { old, new: next };
}

describe("markFindTokens", () => {
  it("returns the input unchanged when there is no query", () => {
    const input = tokens([[{ type: "text", value: "hello" }]], []);
    expect(markFindTokens(input, undefined, false)).toBe(input);
    expect(markFindTokens(input, "", false)).toBe(input);
  });

  it("returns null/undefined input unchanged", () => {
    expect(markFindTokens(null, "x", false)).toBeNull();
    expect(markFindTokens(undefined, "x", false)).toBeUndefined();
  });

  it("splits a text token into surrounding text and a find mark token", () => {
    const input = tokens([[{ type: "text", value: "alpha beta alpha" }]], []);
    const result = markFindTokens(input, "alpha", false);
    const line = result!.old[0];
    expect(line).toEqual([
      { type: "mark", markType: "find", value: "alpha" },
      { type: "text", value: " beta " },
      { type: "mark", markType: "find", value: "alpha" },
    ]);
  });

  it("matches case-insensitively by default and preserves original casing", () => {
    const input = tokens([], [[{ type: "text", value: "Const VALUE" }]]);
    const result = markFindTokens(input, "value", false);
    expect(result!.new[0]).toEqual([
      { type: "text", value: "Const " },
      { type: "mark", markType: "find", value: "VALUE" },
    ]);
  });

  it("respects case sensitivity when requested", () => {
    const input = tokens([[{ type: "text", value: "Value value" }]], []);
    const result = markFindTokens(input, "value", true);
    expect(result!.old[0]).toEqual([
      { type: "text", value: "Value " },
      { type: "mark", markType: "find", value: "value" },
    ]);
  });

  it("preserves the original token type on non-matching slices (keeps syntax colors)", () => {
    const input = tokens([[{ type: "keyword", value: "constant" }]], []);
    const result = markFindTokens(input, "ant", false);
    expect(result!.old[0]).toEqual([
      { type: "keyword", value: "const" },
      { type: "mark", markType: "find", value: "ant" },
    ]);
  });

  it("recurses into child tokens (e.g. markEdits edit wrappers)", () => {
    const input = tokens(
      [
        [
          {
            type: "edit",
            children: [{ type: "text", value: "alpha" }],
          },
        ],
      ],
      []
    );
    const result = markFindTokens(input, "alp", false);
    expect(result!.old[0]).toEqual([
      {
        type: "edit",
        children: [
          { type: "mark", markType: "find", value: "alp" },
          { type: "text", value: "ha" },
        ],
      },
    ]);
  });

  it("leaves existing mark tokens untouched", () => {
    const input = tokens(
      [[{ type: "mark", markType: "edit", value: "alpha" }]],
      []
    );
    const result = markFindTokens(input, "alpha", false);
    expect(result!.old[0]).toEqual([
      { type: "mark", markType: "edit", value: "alpha" },
    ]);
  });

  it("marks path-like text in diff tokens without creating reference-chip metadata", () => {
    const input = tokens(
      [[{ type: "string", value: "@ctrlyoke/src/ui/webview-react/utils/codemirrorTheme.ts" }]],
      []
    );

    const result = markFindTokens(input, "webview-react", false);

    expect(result!.old[0]).toEqual([
      { type: "string", value: "@ctrlyoke/src/ui/" },
      { type: "mark", markType: "find", value: "webview-react" },
      { type: "string", value: "/utils/codemirrorTheme.ts" },
    ]);
    expect(result!.old[0].some((token) => "attrs" in token)).toBe(false);
  });
});
