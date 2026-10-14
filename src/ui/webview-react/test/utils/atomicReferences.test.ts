import { describe, expect, it } from "vitest";
import {
  CHART_ACCENT_COLORS,
  createAtomicReferencePresentation,
  createFileReferenceChip,
  findConditionOutputRefs,
  findAtomicReferences,
  findContextReferenceMatches,
  findInlinePriorContextRefs,
  findUnknownConditionOutputFields,
  projectAtomicReferenceFind,
  referenceBasename,
  SYMBOL_ICON_COLORS,
  SYMBOL_KIND_ICONS,
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

  it("keeps a filename containing ! as a single file reference", () => {
    expect(findContextReferenceMatches("Review @data!file.csv")).toEqual([
      {
        from: "Review ".length,
        to: "Review @data!file.csv".length,
        type: "file",
        path: "data!file.csv",
      },
    ]);
  });

  it("does not parse Markdown image syntax as a secret reference", () => {
    expect(findContextReferenceMatches("![alt](url)")).toEqual([]);
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

    it.each([
      ["#sym:src/a.ts:MyClass:1-2", undefined],
      ["#sym.class:src/a.ts:MyClass:1-2", "class"],
      [
        '#sym.type-parameter:"src/my repo/a.ts":"My Type":3-9',
        "type-parameter",
      ],
      ["#sym.widget:src/a.ts:MyClass:1-2", "widget"],
    ])("parses %s with the embedded kind %s", (token, symbolKind) => {
      const matches = findContextReferenceMatches(token);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        from: 0,
        to: token.length,
        type: "symbol",
      });
      expect(matches[0].symbolKind).toBe(symbolKind);
    });

    it("preserves exact offsets for a kinded reference", () => {
      const token = '#sym.enum-member:"src/a b.ts":"get value":10-40';
      const text = `before ${token} after`;
      expect(findContextReferenceMatches(text)).toEqual([
        {
          from: "before ".length,
          to: "before ".length + token.length,
          type: "symbol",
          symbolKind: "enum-member",
          path: "src/a b.ts",
          symbolName: "get value",
          lineStart: "10",
          lineEnd: "40",
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

  it("uses an embedded kind before falling back to the generic icon", () => {
    const chips = findAtomicReferences("#sym.class:src/a.ts:MyClass:10-20");
    expect(chips[0]).toMatchObject({ icon: "symbol-class" });
  });

  it("uses the resolver before an embedded kind", () => {
    const chips = findAtomicReferences(
      "#sym.class:src/a.ts:MyClass:10-20",
      () => "symbol-interface"
    );
    expect(chips[0]).toMatchObject({ icon: "symbol-interface" });
  });

  it("maps every symbol kind to a colored codicon", () => {
    const expected: Record<string, string> = {
      file: "symbol-file",
      module: "symbol-module",
      namespace: "symbol-module",
      package: "symbol-module",
      class: "symbol-class",
      method: "symbol-method",
      property: "symbol-property",
      field: "symbol-field",
      constructor: "symbol-constructor",
      enum: "symbol-enum",
      interface: "symbol-interface",
      function: "symbol-function",
      variable: "symbol-variable",
      constant: "symbol-constant",
      string: "symbol-value",
      number: "symbol-value",
      boolean: "symbol-value",
      array: "symbol-value",
      object: "symbol-value",
      key: "symbol-property",
      null: "symbol-value",
      "enum-member": "symbol-enum-member",
      struct: "symbol-struct",
      event: "symbol-event",
      operator: "symbol-operator",
      "type-parameter": "symbol-type-parameter",
    };

    expect(SYMBOL_KIND_ICONS).toEqual(expected);
    for (const icon of Object.values(SYMBOL_KIND_ICONS)) {
      expect(SYMBOL_ICON_COLORS[icon]).toBeDefined();
    }
  });

  it("gives an un-kinded symbol the generic icon with an accent color", () => {
    const chips = findAtomicReferences("#sym:src/a.ts:MyClass:10-20");
    expect(chips[0]).toMatchObject({ icon: "symbol-misc" });
    expect(SYMBOL_ICON_COLORS[chips[0].icon]).toBeDefined();
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

  it("only decorates complete git-change references", () => {
    expect(
      findAtomicReferences(
        "~differently ~1500000x ~staged_files ~stash:1a ~diff. (~staged)"
      ).map((ref) => ref.attrs?.["data-git-ref"])
    ).toEqual(["diff", "staged"]);
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

  it("recognizes summary prior-context references as summary chips", () => {
    expect(findAtomicReferences("Use $step:summary:1,3-4 here")).toMatchObject([
      {
        icon: "book",
        label: "step 1,3-4 · summary",
        title: "$step:summary:1,3-4",
        attrs: {
          "data-type": "priorContext",
          "data-ref": "step:summary:1,3,4",
        },
      },
    ]);
  });

  it("parses condition-output refs without treating them as prior context", () => {
    const token = "$preCondition:stdout";
    expect(findConditionOutputRefs(token, 7)).toEqual([
      {
        from: 7,
        to: 7 + token.length,
        token,
        phase: "preCondition",
        field: "stdout",
      },
    ]);
    expect(findAtomicReferences(token)[0]).toMatchObject({
      icon: "shield",
      label: "preCondition:stdout",
      title: token,
      attrs: {
        "data-type": "conditionOutput",
        "data-phase": "preCondition",
        "data-field": "stdout",
      },
    });
  });

  it.each([
    "$preCondition:unknownField",
    "$endCondition:unknownField",
    "x$preCondition:stdout",
    "$preCondition:stdoutSuffix",
    "$preCondition:stdout2",
    "$preCondition:stdout_x",
    "$preCondition2:stdout",
  ])("does not chip invalid condition-output ref %s", (token) => {
    expect(findConditionOutputRefs(token)).toEqual([]);
    expect(findAtomicReferences(token)).toEqual([]);
  });

  it.each([",", ".", "-", ")", ":", ";"])(
    "chips a condition-output ref followed by %s",
    (punctuation) => {
      const text = `Fix $preCondition:stdout${punctuation} then retry`;
      expect(findConditionOutputRefs(text)).toEqual([
        {
          from: "Fix ".length,
          to: "Fix $preCondition:stdout".length,
          token: "$preCondition:stdout",
          phase: "preCondition",
          field: "stdout",
        },
      ]);
    }
  );

  it.each([
    ["$preCondition:stdout2", "stdout2", "stdout"],
    ["$endCondition:exitCodes", "exitCodes", "exitCode"],
    ["$endCondition:STDERR", "STDERR", "stderr"],
    ["$preCondition:stdo", "stdo", "stdout"],
    ["$preCondition:bogus", "bogus", undefined],
  ])(
    "reports %s as an unknown field with suggestion %s → %s",
    (token, field, suggestion) => {
      expect(findUnknownConditionOutputFields(`a ${token}`, 10)).toEqual([
        {
          from: 12,
          to: 12 + token.length,
          token,
          phase: token.startsWith("$pre") ? "preCondition" : "endCondition",
          field,
          ...(suggestion ? { suggestion } : {}),
        },
      ]);
    }
  );

  it("does not report known fields or unknown phases as unknown fields", () => {
    expect(
      findUnknownConditionOutputFields(
        "$preCondition:stdout, $other:stdout2 $previous"
      )
    ).toEqual([]);
  });

  it("renders end-condition output with the checklist icon", () => {
    expect(findAtomicReferences("$endCondition:stderr")[0]).toMatchObject({
      icon: "checklist",
      label: "endCondition:stderr",
    });
  });

  it("renders a secret reference as an atomic key chip", () => {
    expect(findAtomicReferences("Use !SERVICE_TOKEN here")).toEqual([
      {
        from: "Use ".length,
        to: "Use !SERVICE_TOKEN".length,
        icon: "key",
        label: "SERVICE_TOKEN",
        title: "!SERVICE_TOKEN",
        attrs: {
          "data-type": "secret",
          "data-secret-name": "SERVICE_TOKEN",
        },
      },
    ]);
  });

  it("uses the shared warning-border validity path for an unknown secret", () => {
    const token = "!UNKNOWN_TOKEN";
    expect(
      findAtomicReferences(token, undefined, (reference) =>
        reference === token ? false : undefined
      )[0]
    ).toMatchObject({ invalid: true });
  });

  it("uses the shared warning-border validity path for invalid prior context", () => {
    const token = "$step:4";
    expect(
      findAtomicReferences(token, undefined, (reference) =>
        reference === token ? false : undefined
      )[0]
    ).toMatchObject({ invalid: true });
  });

  it("labels a $previous:N reference with its count", () => {
    const text = "Look at $previous:3, then fix it";
    const [chip] = findAtomicReferences(text);
    expect(chip).toMatchObject({
      label: "previous 3",
      title: "$previous:3",
      attrs: { "data-type": "priorContext", "data-ref": "previous:3" },
    });
    expect(text.slice(chip.from, chip.to)).toBe("$previous:3");
  });

  it("locates prior-context refs with the shared runtime parser", () => {
    expect(findInlinePriorContextRefs("x $previous:2 $step:1,", 10)).toEqual([
      {
        from: 12,
        to: 23,
        token: "$previous:2",
        ref: { kind: "previous", count: 2, detail: "full" },
      },
      {
        from: 24,
        to: 31,
        token: "$step:1",
        ref: { kind: "step", indices: [1], detail: "full" },
      },
    ]);
  });

  it("labels a $step range reference", () => {
    const chips = findAtomicReferences("$step:1,3-4");
    expect(chips[0]).toMatchObject({
      label: "step 1,3-4",
      attrs: { "data-type": "priorContext", "data-ref": "step:1,3,4" },
    });
  });

  it("labels a long contiguous $step range in compact range notation", () => {
    const [chip] = findAtomicReferences("$step:1-99");
    expect(chip.label).toBe("step 1-99");
  });

  it("rejects invalid and oversized $step ranges without expanding them", () => {
    expect(findInlinePriorContextRefs("see $step:1-5000000000")).toEqual([]);
    expect(findInlinePriorContextRefs("see $step:0")).toEqual([]);
  });

  it("treats a trailing comma on $step: as sentence punctuation", () => {
    const text = "First review $step:1,4, then tell me which design is better";
    const chips = findAtomicReferences(text);
    expect(chips[0]).toMatchObject({
      label: "step 1,4",
      title: "$step:1,4",
      attrs: { "data-type": "priorContext", "data-ref": "step:1,4" },
    });
    // The trailing comma itself must stay out of the chip's matched range.
    expect(text.slice(chips[0].from, chips[0].to)).toBe("$step:1,4");
  });

  it("labels a /skill: reference with its name and the tools icon", () => {
    const chips = findAtomicReferences("using /skill:commit here");
    expect(chips).toEqual([
      {
        from: "using ".length,
        to: "using /skill:commit".length,
        icon: "tools",
        label: "commit",
        title: "/skill:commit",
        attrs: { "data-type": "skill", "data-skill-name": "commit" },
      },
    ]);
    expect(SYMBOL_ICON_COLORS[chips[0].icon]).toBe(CHART_ACCENT_COLORS.orange);
  });

  it("labels a /mcp: reference with its name and the mcp icon", () => {
    const chips = findAtomicReferences("using /mcp:playwright here");
    expect(chips).toEqual([
      {
        from: "using ".length,
        to: "using /mcp:playwright".length,
        icon: "mcp",
        label: "playwright",
        title: "/mcp:playwright",
        attrs: { "data-type": "mcp", "data-mcp-server-name": "playwright" },
      },
    ]);
    expect(SYMBOL_ICON_COLORS[chips[0].icon]).toBe(CHART_ACCENT_COLORS.orange);
  });

  it("leaves a plain native slash command alone", () => {
    expect(findAtomicReferences("/commit and /mcp")).toEqual([]);
  });

  it("keeps multiple /mcp: references distinguishable after chipping", () => {
    const chips = findAtomicReferences(
      "only use /mcp:a if needed, and only use /mcp:b if needed"
    );
    expect(chips.map((c) => c.attrs["data-mcp-server-name"])).toEqual([
      "a",
      "b",
    ]);
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

  it("keeps references inside a shorter fence nested in a longer fence inert", () => {
    const doc = "````md\n```\n$previous\n```\n````";
    expect(findAtomicReferences(doc)).toEqual([]);
  });

  describe("code ranges shared with the runtime parsers", () => {
    const LIVE = "@src/a.ts !TOKEN_A /skill:alpha $previous";
    const FENCE = "```";
    const chipTexts = (doc: string) =>
      findAtomicReferences(doc).map((chip) => doc.slice(chip.from, chip.to));
    const ALL_LIVE = ["@src/a.ts", "!TOKEN_A", "/skill:alpha", "$previous"];

    it("does not let a mid-line triple backtick shift a later fence", () => {
      expect(
        chipTexts(
          `Use ${FENCE} fences. Review ${LIVE} now.\n${FENCE}\nexample @x/y.ts !TOKEN_B\n${FENCE}\n`
        )
      ).toEqual(ALL_LIVE);
    });

    it("keeps every token in a single-backtick span inert", () => {
      expect(chipTexts(`Quote \`${LIVE}\` then @src/b.ts`)).toEqual([
        "@src/b.ts",
      ]);
    });

    it("lets a double-backtick span contain a single backtick", () => {
      expect(chipTexts(`Quote \`\`a \` ${LIVE}\`\` then !TOKEN_B`)).toEqual([
        "!TOKEN_B",
      ]);
    });

    it("keeps unpaired backticks plain and multiline code spans inert", () => {
      expect(
        chipTexts("It's a ` stray @src/a.ts !TOKEN_A\n/skill:alpha $previous")
      ).toEqual(ALL_LIVE);
      expect(
        chipTexts("Open `@src/a.ts !TOKEN_A\nclose /skill:alpha` $previous")
      ).toEqual(["$previous"]);
    });

    it("does not treat an escaped backtick as a delimiter", () => {
      expect(chipTexts(`Escaped \\\` ${LIVE} \\\` and \`!TOKEN_B\``)).toEqual(
        ALL_LIVE
      );
    });

    it("accepts a fence indented up to three spaces, not four", () => {
      expect(chipTexts(`   ${FENCE}\n${LIVE}\n   ${FENCE}\n@src/b.ts`)).toEqual(
        ["@src/b.ts"]
      );
      expect(chipTexts(`    ${FENCE}\n${LIVE}\n    ${FENCE}\n`)).toEqual(
        ALL_LIVE
      );
    });
  });

  it("does not decorate prior-context text that continues with an underscore", () => {
    expect(findAtomicReferences("$previous_output")).toEqual([]);
  });

  it("excludes condition-output references inside fenced blocks", () => {
    expect(findAtomicReferences("```\n$preCondition:stdout\n```")).toEqual([]);
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

describe("slash-token reference chip compaction", () => {
  it("hides the /skill: prefix behind the compact label and expands to it on a hidden match", () => {
    const source = "/skill:commit";
    const chip = findAtomicReferences(source)[0];
    const presentation = createAtomicReferencePresentation(chip, source);

    expect(projectAtomicReferenceFind(presentation, [])).toMatchObject({
      text: "commit",
      expanded: false,
    });

    expect(
      projectAtomicReferenceFind(presentation, [
        { start: 0, end: "/skill".length, active: true },
      ])
    ).toMatchObject({ text: source, expanded: true });
  });

  it("hides the /mcp: prefix behind the compact label and expands to it on a hidden match", () => {
    const source = "/mcp:playwright";
    const chip = findAtomicReferences(source)[0];
    const presentation = createAtomicReferencePresentation(chip, source);

    expect(projectAtomicReferenceFind(presentation, [])).toMatchObject({
      text: "playwright",
      expanded: false,
    });

    expect(
      projectAtomicReferenceFind(presentation, [
        { start: 0, end: "/mcp".length, active: true },
      ])
    ).toMatchObject({ text: source, expanded: true });
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
