import { describe, expect, it } from "vitest";
import {
  findAtomicReferences,
  findContextReferenceMatches,
} from "@utils/atomicReferences";

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

describe("atomic reference presentation", () => {
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
});
