import { describe, expect, it } from "vitest";
import {
  createAtomicReferencePresentation,
  createFileReferenceChip,
  findAtomicReferences,
  findContextReferenceMatches,
  projectAtomicReferenceFind,
  referenceBasename,
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

  // These must agree with parseSymbolReferences in src/utils/FileReferenceParser.ts.
  // The two parsers are separate by design, but a reference this one chips while
  // the runtime one ignores renders clickable and silently expands to nothing.
  describe("#sym: field grammar parity with the runtime parser", () => {
    it.each([
      ["Foo<T>", "src/a.ts"],
      ["my-thing", "src/a.ts"],
      ["Foo.bar", "src/a.ts"],
      ["#private", "src/a.ts"],
      ["doThing()", "src/a.ts"],
    ])("parses the bare symbol name %s", (name, path) => {
      const token = `#sym:${path}:${name}:1-2`;
      expect(findContextReferenceMatches(token)).toEqual([
        {
          from: 0,
          to: token.length,
          type: "symbol",
          path,
          symbolName: name,
          lineStart: "1",
          lineEnd: "2",
        },
      ]);
    });

    it("parses quoted path and quoted symbol name together", () => {
      const token = '#sym:"C:/dev/my repo/a.ts":"get value":3-9';
      expect(findContextReferenceMatches(token)).toEqual([
        {
          from: 0,
          to: token.length,
          type: "symbol",
          path: "C:/dev/my repo/a.ts",
          symbolName: "get value",
          lineStart: "3",
          lineEnd: "9",
        },
      ]);
    });

    it("does not let a bare symbol name swallow prose", () => {
      expect(
        findContextReferenceMatches("see #sym:a.ts:MyClass, at 12:30-45 ok")
      ).toEqual([]);
    });

    it("parses a quoted #selection: path with a drive colon", () => {
      const token = '#selection:"C:/dev/repo/a.ts":10-20';
      expect(findContextReferenceMatches(token)).toEqual([
        {
          from: 0,
          to: token.length,
          type: "lineRange",
          path: "C:/dev/repo/a.ts",
          lineStart: "10",
          lineEnd: "20",
        },
      ]);
    });
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

// Multi-root workspaces send the harness absolute paths, so file-operation
// events come back with OS-native separators — on Windows, backslashes.
describe("file-operation reference chips on backslash paths", () => {
  const winPath = "c:\\dev\\ctrlyoke\\src\\utils\\ContextExpander.ts";

  it("takes the basename of a Windows absolute path", () => {
    expect(referenceBasename(winPath)).toBe("ContextExpander.ts");
    expect(referenceBasename("c:\\dev\\ctrlyoke\\src\\")).toBe("src");
  });

  it("labels a backslash file event with just its basename", () => {
    expect(createFileReferenceChip(winPath)).toMatchObject({
      icon: "symbol-file",
      label: "ContextExpander.ts",
      title: winPath,
      attrs: { "data-type": "file", "data-path": winPath },
    });
  });

  it("labels a backslash directory event with a trailing slash", () => {
    expect(createFileReferenceChip("c:\\dev\\ctrlyoke\\src\\")).toMatchObject({
      icon: "folder",
      label: "src/",
      attrs: { "data-type": "directory" },
    });
  });

  it("renders compact until a find match reaches the hidden directory portion", () => {
    const descriptor = createFileReferenceChip(winPath);
    const presentation = createAtomicReferencePresentation(descriptor, winPath);

    expect(projectAtomicReferenceFind(presentation, [])).toMatchObject({
      text: "ContextExpander.ts",
      expanded: false,
    });

    const hiddenFrom = winPath.indexOf("ctrlyoke");
    expect(
      projectAtomicReferenceFind(presentation, [
        {
          start: hiddenFrom,
          end: hiddenFrom + "ctrlyoke".length,
          active: true,
        },
      ])
    ).toMatchObject({
      text: winPath,
      expanded: true,
      marks: [
        { from: hiddenFrom, to: hiddenFrom + "ctrlyoke".length, active: true },
      ],
    });
  });
});

describe("atomic reference find projection", () => {
  const presentation = (
    sourceText: string,
    compactLabel: string,
    sourceFrom: number,
    sourceTo: number,
    labelFrom: number,
    labelTo: number,
    rowFrom = 10
  ) => ({
    sourceText,
    rowRange: { from: rowFrom, to: rowFrom + sourceText.length },
    compactRanges: [
      {
        source: { from: sourceFrom, to: sourceTo },
        label: { from: labelFrom, to: labelTo },
      },
    ],
    compactLabel,
    selectionText: sourceText,
  });

  it("keeps a visible-label match compact and marks its label offsets", () => {
    const source = "@src/deep/codemirrorTheme.ts";
    const basenameFrom = source.lastIndexOf("codemirrorTheme.ts");
    expect(
      projectAtomicReferenceFind(
        presentation(
          source,
          "codemirrorTheme.ts",
          basenameFrom,
          source.length,
          0,
          "codemirrorTheme.ts".length
        ),
        [
          {
            start: 10 + basenameFrom + 2,
            end: 10 + basenameFrom + 10,
            active: false,
          },
        ]
      )
    ).toEqual({
      text: "codemirrorTheme.ts",
      marks: [{ from: 2, to: 10, active: false }],
      expanded: false,
      selectionText: source,
    });
  });

  it("expands a hidden directory match and marks the exact source substring", () => {
    const source = "@ctrlyoke/src/ui/webview-react/utils/codemirrorTheme.ts";
    const basenameFrom = source.lastIndexOf("codemirrorTheme.ts");
    const hiddenFrom = source.indexOf("webview-react");
    const result = projectAtomicReferenceFind(
      presentation(
        source,
        "codemirrorTheme.ts",
        basenameFrom,
        source.length,
        0,
        "codemirrorTheme.ts".length
      ),
      [
        {
          start: 10 + hiddenFrom,
          end: 10 + hiddenFrom + "webview-react".length,
          active: true,
        },
      ]
    );

    expect(result).toEqual({
      text: source,
      marks: [
        {
          from: hiddenFrom,
          to: hiddenFrom + "webview-react".length,
          active: true,
        },
      ],
      expanded: true,
      selectionText: source,
      activeMarkIndex: 0,
    });
  });

  it("projects several matches in one reference without changing their order", () => {
    const source = "@src/webview-react/webview-react.ts";
    const hiddenFrom = source.indexOf("webview-react");
    const secondFrom = source.lastIndexOf("webview-react");
    const result = projectAtomicReferenceFind(
      presentation(
        source,
        "webview-react.ts",
        secondFrom,
        source.length,
        0,
        "webview-react.ts".length
      ),
      [
        { start: 10 + hiddenFrom, end: 10 + hiddenFrom + 12, active: false },
        { start: 10 + secondFrom, end: 10 + secondFrom + 12, active: true },
      ]
    );

    expect(result.expanded).toBe(true);
    expect(result.marks).toEqual([
      { from: hiddenFrom, to: hiddenFrom + 12, active: false },
      { from: secondFrom, to: secondFrom + 12, active: true },
    ]);
    expect(result.activeMarkIndex).toBe(1);
  });

  it("forwards offsets from either case-sensitive or insensitive searches", () => {
    const source = "@src/WebView-React/codemirrorTheme.ts";
    const hiddenFrom = source.indexOf("WebView-React");
    const descriptor = presentation(
      source,
      "codemirrorTheme.ts",
      source.lastIndexOf("codemirrorTheme.ts"),
      source.length,
      0,
      "codemirrorTheme.ts".length
    );

    expect(
      projectAtomicReferenceFind(descriptor, [
        { start: 10 + hiddenFrom, end: 10 + hiddenFrom + 13, active: false },
      ]).marks
    ).toEqual([{ from: hiddenFrom, to: hiddenFrom + 13, active: false }]);
    expect(
      projectAtomicReferenceFind(descriptor, [
        { start: 10 + hiddenFrom + 1, end: 10 + hiddenFrom + 5, active: true },
      ]).marks
    ).toEqual([{ from: hiddenFrom + 1, to: hiddenFrom + 5, active: true }]);
  });

  it("collapses with no matches or when matches only touch visible text", () => {
    const source = "@src/hidden/codemirrorTheme.ts";
    const descriptor = presentation(
      source,
      "codemirrorTheme.ts",
      source.lastIndexOf("codemirrorTheme.ts"),
      source.length,
      0,
      "codemirrorTheme.ts".length
    );

    expect(projectAtomicReferenceFind(descriptor, [])).toMatchObject({
      text: "codemirrorTheme.ts",
      marks: [],
      expanded: false,
    });
    expect(
      projectAtomicReferenceFind(descriptor, [
        {
          start: 10 + source.lastIndexOf("codemirror"),
          end: 10 + source.length,
          active: false,
        },
      ])
    ).toMatchObject({ text: "codemirrorTheme.ts", expanded: false });
  });

  it("maps an explicit label and hidden target independently", () => {
    const source = "theme file src/ui/webview-react/utils/codemirrorTheme.ts";
    const label = "theme file";
    const descriptor = {
      sourceText: source,
      rowRange: { from: 4, to: 4 + source.length },
      compactRanges: [
        {
          source: { from: 0, to: label.length },
          label: { from: 0, to: label.length },
        },
      ],
      compactLabel: label,
      selectionText: label,
    };

    expect(
      projectAtomicReferenceFind(descriptor, [
        {
          start: 4 + 2,
          end: 4 + 6,
          active: false,
        },
      ])
    ).toMatchObject({
      text: label,
      expanded: false,
      marks: [{ from: 2, to: 6, active: false }],
    });

    const targetFrom = source.indexOf("src/");
    const hiddenFrom =
      targetFrom + source.slice(targetFrom).indexOf("webview-react");
    expect(
      projectAtomicReferenceFind(descriptor, [
        {
          start: 4 + hiddenFrom,
          end: 4 + hiddenFrom + "webview-react".length,
          active: true,
        },
      ])
    ).toMatchObject({
      text: source,
      expanded: true,
      marks: [
        {
          from: hiddenFrom,
          to: hiddenFrom + "webview-react".length,
          active: true,
        },
      ],
    });
  });

  it("expands when a match spans the compact-label and hidden boundary", () => {
    const source = "@src/webview-react/codemirrorTheme.ts";
    const basenameFrom = source.lastIndexOf("codemirrorTheme.ts");
    const result = projectAtomicReferenceFind(
      presentation(
        source,
        "codemirrorTheme.ts",
        basenameFrom,
        source.length,
        0,
        "codemirrorTheme.ts".length
      ),
      [
        {
          start: 10 + basenameFrom - 3,
          end: 10 + basenameFrom + 5,
          active: false,
        },
      ]
    );

    expect(result).toMatchObject({
      text: source,
      expanded: true,
      marks: [{ from: basenameFrom - 3, to: basenameFrom + 5, active: false }],
    });
  });
});
