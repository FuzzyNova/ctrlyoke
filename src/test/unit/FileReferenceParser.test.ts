import * as assert from "assert";
import { suite, test } from "mocha";
import {
  parseAtReferences,
  parseSelectionReferences,
  parseSymbolReferences,
  parseDirectoryReferences,
  parseAllFileReferences,
  parseGitChangeReferences,
  formatInlinePriorContextBody,
  parseInlinePriorContextBody,
  parseInlinePriorContextRefs,
  encodePriorContextTokenRef,
  decodePriorContextTokenRef,
  maskCodeRanges,
  fenceLiteral,
  LITERAL_FENCE_INFO,
  findCodeRanges,
} from "../../utils/FileReferenceParser";
import { parseSecretReferences } from "../../utils/SecretReferenceParser";
import { scanCtrlYokeSlashTokens } from "../../utils/CtrlYokeSlashTokens";
import {
  buildFileReference,
  buildSelectionReference,
  buildSymbolReference,
} from "../../completions/ContextReferenceBuilder";

suite("FileReferenceParser", () => {
  suite("findCodeRanges markdown parity", () => {
    test("masks tilde fences", () => {
      const text = "~~~ts\n@src/a.ts\n~~~";
      assert.deepStrictEqual(findCodeRanges(text), [
        { from: 0, to: text.length },
      ]);
      assert.deepStrictEqual(parseAtReferences(text), []);
    });

    test("does not close a fence with an info string", () => {
      const text = "```\n@src/a.ts\n```js\n@src/b.ts\n```";
      assert.deepStrictEqual(findCodeRanges(text), [
        { from: 0, to: text.length },
      ]);
      assert.deepStrictEqual(parseAtReferences(text), []);
    });

    test("recognizes CRLF fences and keeps ranges indexed to the original text", () => {
      const lf = "Intro\n```ts\nsee $previous and @src/a.ts\n```\nafter";
      const crlf = lf.replace(/\n/g, "\r\n");
      const lfRange = findCodeRanges(lf)[0];
      const crlfRange = findCodeRanges(crlf)[0];

      assert.deepStrictEqual(
        lfRange && lf.slice(lfRange.from, lfRange.to),
        "```ts\nsee $previous and @src/a.ts\n```"
      );
      assert.deepStrictEqual(
        crlfRange && crlf.slice(crlfRange.from, crlfRange.to),
        "```ts\r\nsee $previous and @src/a.ts\r\n```"
      );
      assert.strictEqual(
        lf.slice(lfRange!.from, lfRange!.to).replace(/\r\n/g, "\n"),
        crlf.slice(crlfRange!.from, crlfRange!.to).replace(/\r\n/g, "\n")
      );
      assert.deepStrictEqual(parseAtReferences(crlf), []);
      assert.deepStrictEqual(parseInlinePriorContextRefs(crlf), []);
    });

    test("masks a fence indented inside a list item", () => {
      const text = "- item\n\n    ```\n    @src/a.ts\n    ```";
      assert.deepStrictEqual(parseAtReferences(text), []);
      assert.deepStrictEqual(findCodeRanges(text), [
        { from: text.indexOf("```"), to: text.lastIndexOf("```") + 3 },
      ]);
    });

    test("masks a fence inside a blockquote", () => {
      const text = "> ```\n> @src/a.ts\n> ```";
      assert.deepStrictEqual(parseAtReferences(text), []);
      assert.deepStrictEqual(findCodeRanges(text), [
        { from: text.indexOf("```"), to: text.lastIndexOf("```") + 3 },
      ]);
    });

    test("masks inline code across one line break but not a blank line", () => {
      const text = "a `@src/a.ts\n@src/b.ts` c\n\n@src/c.ts";
      assert.deepStrictEqual(
        parseAtReferences(text).map(({ path }) => path),
        ["src/c.ts"]
      );
      assert.deepStrictEqual(findCodeRanges(text), [
        { from: 2, to: text.indexOf("` c") + 1 },
      ]);
    });

    test("keeps an unclosed fence live", () => {
      const text = "```ts\n@src/a.ts";
      assert.deepStrictEqual(findCodeRanges(text), []);
      assert.deepStrictEqual(
        parseAtReferences(text).map(({ path }) => path),
        ["src/a.ts"]
      );
    });

    test("finds inline spans after an unmatched opener", () => {
      for (const text of ["``unclosed then `@x`", "a ` b ``@x``"]) {
        const from = text.indexOf("`@x`");
        const closer = text.indexOf("``@x``");
        const expectedFrom = closer >= 0 ? closer : from;
        const expectedTo = closer >= 0 ? closer + 6 : from + 4;
        assert.deepStrictEqual(findCodeRanges(text), [
          { from: expectedFrom, to: expectedTo },
        ]);
      }
    });

    test("a backslash escapes only the first tick in a backtick run", () => {
      const text = "\\``@x`";
      assert.deepStrictEqual(findCodeRanges(text), [
        { from: 2, to: text.length },
      ]);
    });

    test("ignores backslashes inside inline code when pairing delimiters", () => {
      const text = "Run `C:\\tmp\\` then @file.md and `x`";
      assert.deepStrictEqual(findCodeRanges(text), [
        { from: text.indexOf("`C:"), to: text.indexOf(" then") },
        { from: text.lastIndexOf("`x`"), to: text.length },
      ]);
      assert.deepStrictEqual(
        parseAtReferences(text).map(({ path }) => path),
        ["file.md"]
      );
    });

    test("finds later closed fences after an unclosed fence opener", () => {
      for (const text of [
        "~~~~~~~~~~\nNotes\n\n```\n$previous\n```",
        "````\n\n```\n$previous\n```",
      ]) {
        const from = text.indexOf("```", text.indexOf("\n\n") + 2);
        assert.deepStrictEqual(findCodeRanges(text), [
          { from, to: text.lastIndexOf("```") + 3 },
        ]);
        assert.deepStrictEqual(parseInlinePriorContextRefs(text), []);
      }
    });

    test("recognizes a fence on a list marker line", () => {
      for (const text of ["- ```\n  code @x\n  ```", "1. ```\n   @x\n   ```"]) {
        assert.deepStrictEqual(parseAtReferences(text), []);
        assert.deepStrictEqual(findCodeRanges(text), [
          { from: text.indexOf("```"), to: text.lastIndexOf("```") + 3 },
        ]);
      }
    });

    test("ends a blockquote fence with its container and rejects lazy code continuation", () => {
      const endedQuote = "> ```\n> code\n\nRegular @src/ref.md text\n\n```\nx";
      assert.deepStrictEqual(
        findCodeRanges(endedQuote).map(({ from, to }) => ({ from, to })),
        []
      );
      assert.deepStrictEqual(
        parseAtReferences(endedQuote).map(({ path }) => path),
        ["src/ref.md"]
      );

      const lazyContinuation = "> ```\n@src/x.md\n> ```";
      assert.deepStrictEqual(
        parseAtReferences(lazyContinuation).map(({ path }) => path),
        ["src/x.md"]
      );
    });

    test("allows backticks in tilde fence info and stops inline spans at block starts", () => {
      const tilde = "~~~ `js`\n@a\n~~~";
      assert.deepStrictEqual(findCodeRanges(tilde), [
        { from: 0, to: tilde.length },
      ]);
      for (const text of ["- a `x\n- b` @y", "`a\n# H `b"]) {
        assert.deepStrictEqual(findCodeRanges(text), []);
      }
    });

    test("scans a dense backtick line within a linear-time budget", () => {
      const text = "a`b``".repeat(50_000);
      const startedAt = Date.now();
      const ranges = findCodeRanges(text);
      assert.ok(ranges.length > 0);
      assert.ok(
        Date.now() - startedAt < 2500,
        `findCodeRanges took ${Date.now() - startedAt}ms for ${text.length} chars`
      );
    });

    test("scans many unclosed fence openers in linear time", () => {
      const text = "```x\n".repeat(20_000);
      const startedAt = Date.now();
      assert.deepStrictEqual(findCodeRanges(text), []);
      assert.ok(
        Date.now() - startedAt < 1000,
        `findCodeRanges took ${Date.now() - startedAt}ms for ${text.length} chars`
      );
    });

    test("never reports a span nested inside or overlapping another", () => {
      for (const [text, expected] of [
        ["`` x ` y `` @x ` z", ["`` x ` y ``"]],
        ["``a`b`` c `@x", ["``a`b``"]],
        ["``a `b` c`` @x", ["``a `b` c``"]],
      ] as const) {
        assert.deepStrictEqual(
          findCodeRanges(text).map(({ from, to }) => text.slice(from, to)),
          expected,
          text
        );
      }
    });

    test("an escaped run's remainder can open a span but never closes one", () => {
      for (const text of ["`a \\``@x`", "``a \\```@x``"]) {
        assert.deepStrictEqual(
          findCodeRanges(text),
          [{ from: 0, to: text.length }],
          text
        );
      }
      assert.deepStrictEqual(findCodeRanges("#``-  \\`\\```"), []);
    });

    test("masks code in linear time", () => {
      const text = "a`b``".repeat(80_000);
      const startedAt = Date.now();
      const masked = maskCodeRanges(text);
      assert.strictEqual(masked.length, text.length);
      assert.ok(
        Date.now() - startedAt < 2500,
        `maskCodeRanges took ${Date.now() - startedAt}ms for ${text.length} chars`
      );
    });

    test("keeps a list fence open across a blank line before indented content", () => {
      const text = "* item\n\n  ```\n  @x\n\n  ```";
      assert.deepStrictEqual(findCodeRanges(text), [
        { from: text.indexOf("```"), to: text.lastIndexOf("```") + 3 },
      ]);
    });
  });

  suite("maskCodeRanges", () => {
    test("keeps a three-backtick block inside a four-backtick fence masked", () => {
      const prompt = "````markdown\n```html\n@src/x.ts $previous\n```\n````";
      const masked = maskCodeRanges(prompt);

      assert.ok(masked.includes("\x00src\x00x.ts \x00previous"));
      assert.strictEqual(masked.match(/`+/g)?.length, 4);
    });

    test("preserves triple-backtick masking behavior", () => {
      const prompt = "```text\n@src/x.ts\n```\nthen @src/y.ts";

      assert.strictEqual(
        maskCodeRanges(prompt),
        "```text\n\x00src\x00x.ts\n```\nthen @src/y.ts"
      );
    });

    test("does not let an inserted literal opener close an authored fence", () => {
      const prompt = "```text\n@src/x.ts\n```` text\n@src/y.ts\n````";
      assert.deepStrictEqual(
        parseAtReferences(prompt).map((reference) => reference.path),
        ["src/x.ts"]
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("parseAtReferences", () => {
    test("does not parse an @ reference immediately after a Unicode letter", () => {
      assert.deepStrictEqual(parseAtReferences("café@src/a.ts"), []);
      assert.deepStrictEqual(parseAtReferences("東京@src/a.ts"), []);
    });

    test("keeps extensionless files and directories distinct after punctuation stripping", () => {
      assert.deepStrictEqual(
        parseAtReferences("@scripts/build, @src/.").map(
          ({ path, isDirectory }) => ({ path, isDirectory })
        ),
        [
          { path: "scripts/build", isDirectory: false },
          { path: "src/", isDirectory: true },
        ]
      );
    });

    test("returns empty array for prompt with no references", () => {
      const refs = parseAtReferences("just some text without references");
      assert.deepStrictEqual(refs, []);
    });

    test("returns empty array for empty string", () => {
      const refs = parseAtReferences("");
      assert.deepStrictEqual(refs, []);
    });

    test("parses simple file path reference", () => {
      const refs = parseAtReferences(
        "Please look at @src/utils/helper.ts for context."
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/utils/helper.ts");
      assert.strictEqual(refs[0].isDirectory, false);
    });

    test("parses an at-reference path containing a hash", () => {
      const refs = parseAtReferences("see @src/C#/a.cs");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/C#/a.cs");
    });

    test("parses Windows-style file path", () => {
      const refs = parseAtReferences("See @src\\utils\\helper.ts");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src\\utils\\helper.ts");
    });

    test("parses unquoted Windows drive paths with either separator", () => {
      assert.deepStrictEqual(
        ["@C:/x/a.ts", "@C:\\x\\a.ts"].map((input) =>
          parseAtReferences(input).map((ref) => ref.path)
        ),
        [["C:/x/a.ts"], ["C:\\x\\a.ts"]]
      );
    });

    test("keeps a line suffix outside an unquoted Windows drive path", () => {
      for (const suffix of [":10", ":10-20"]) {
        const text = `Review @C:/x/a.ts${suffix} now`;
        const ref = parseAtReferences(text)[0];
        assert.strictEqual(ref.path, "C:/x/a.ts");
        assert.strictEqual(ref.endOffset, "Review @C:/x/a.ts".length);
      }
    });

    test("parses directory reference (trailing slash)", () => {
      const refs = parseAtReferences("Look at @src/utils/");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/utils/");
      assert.strictEqual(refs[0].isDirectory, true);
    });

    test("parses quoted path with spaces", () => {
      const refs = parseAtReferences('@"path with spaces/file.ts"');
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "path with spaces/file.ts");
    });

    test("strips trailing punctuation from unquoted path (comma)", () => {
      const refs = parseAtReferences("See @src/file.ts, and also");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/file.ts");
    });

    test("strips trailing punctuation from unquoted path (period at sentence end)", () => {
      const refs = parseAtReferences("Check @src/file.ts.");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/file.ts");
    });

    test("strips trailing mixed punctuation from unquoted path (paren + period)", () => {
      const refs = parseAtReferences(
        "See @src/ui/webview-react/components/editor/CodeMirrorEditor.tsx)."
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(
        refs[0].path,
        "src/ui/webview-react/components/editor/CodeMirrorEditor.tsx"
      );
    });

    test("preserves trailing accented and CJK letters while stripping punctuation", () => {
      assert.deepStrictEqual(
        parseAtReferences("See @docs/résumé, then @notes/日本語.").map(
          (ref) => ref.path
        ),
        ["docs/résumé", "notes/日本語"]
      );
    });

    test("strips a trailing unpaired backtick from an @path reference", () => {
      const refs = parseAtReferences("Check @src/file.ts` in the prompt");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/file.ts");
    });

    test("parses multiple file references", () => {
      const refs = parseAtReferences(
        "See @src/a.ts and @src/b.ts for details."
      );
      assert.strictEqual(refs.length, 2);
      assert.strictEqual(refs[0].path, "src/a.ts");
      assert.strictEqual(refs[1].path, "src/b.ts");
    });

    test("ignores @workspace and other mention-style references (no path separators)", () => {
      const refs = parseAtReferences("Use @workspace context please.");
      // @workspace has no . or / or \, so it should be ignored
      assert.deepStrictEqual(refs, []);
    });

    test("parses file with multi-dot extension", () => {
      const refs = parseAtReferences("Look at @config.test.ts here");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "config.test.ts");
    });

    test("preserves file path extensions", () => {
      const refs = parseAtReferences("Check @src/index.js");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/index.js");
    });
  });

  test("does not recognize any reference trigger immediately after a Unicode letter", () => {
    assert.deepStrictEqual(parseInlinePriorContextRefs("café$previous"), []);
    assert.deepStrictEqual(parseAtReferences("café@src/a.ts"), []);
    assert.deepStrictEqual(parseSecretReferences("café!API_TOKEN"), []);
    assert.deepStrictEqual(parseGitChangeReferences("café~diff"), []);
    assert.deepStrictEqual(scanCtrlYokeSlashTokens("café/skill:commit"), []);

    assert.strictEqual(parseInlinePriorContextRefs("cafe $previous").length, 1);
    assert.strictEqual(parseAtReferences("cafe @src/a.ts").length, 1);
    assert.strictEqual(parseSecretReferences("cafe !API_TOKEN").length, 1);
    assert.strictEqual(parseGitChangeReferences("cafe ~diff").length, 1);
    assert.strictEqual(scanCtrlYokeSlashTokens("cafe /skill:commit").length, 1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("parseSelectionReferences", () => {
    test("returns empty array for prompt with no #selection: references", () => {
      const refs = parseSelectionReferences("just normal text");
      assert.deepStrictEqual(refs, []);
    });

    test("parses #selection: reference with line range", () => {
      const refs = parseSelectionReferences(
        "See #selection:src/utils.ts:10-20 for details."
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/utils.ts");
      assert.strictEqual(refs[0].startLine, 10);
      assert.strictEqual(refs[0].endLine, 20);
    });

    test("parses quoted path in #selection: reference", () => {
      const refs = parseSelectionReferences(
        '#selection:"path with spaces/file.ts":5-15'
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "path with spaces/file.ts");
      assert.strictEqual(refs[0].startLine, 5);
      assert.strictEqual(refs[0].endLine, 15);
    });

    test("parses multiple #selection: references", () => {
      const prompt =
        "Look at #selection:src/a.ts:1-10 and #selection:src/b.ts:20-30";
      const refs = parseSelectionReferences(prompt);
      assert.strictEqual(refs.length, 2);
      assert.strictEqual(refs[0].path, "src/a.ts");
      assert.strictEqual(refs[0].startLine, 1);
      assert.strictEqual(refs[0].endLine, 10);
      assert.strictEqual(refs[1].path, "src/b.ts");
      assert.strictEqual(refs[1].startLine, 20);
      assert.strictEqual(refs[1].endLine, 30);
    });

    test("ignores #selection: without line range", () => {
      // #selection: requires a line range — bare reference should not match
      const refs = parseSelectionReferences("#selection:src/utils.ts");
      assert.strictEqual(refs.length, 0);
    });

    test("line range values are parsed as numbers", () => {
      const refs = parseSelectionReferences("#selection:src/file.ts:100-200");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(typeof refs[0].startLine, "number");
      assert.strictEqual(typeof refs[0].endLine, "number");
      assert.strictEqual(refs[0].startLine, 100);
      assert.strictEqual(refs[0].endLine, 200);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("parseSymbolReferences", () => {
    test("returns empty array for prompt with no #sym: references", () => {
      const refs = parseSymbolReferences("normal text");
      assert.deepStrictEqual(refs, []);
    });

    test("parses #sym: reference", () => {
      const refs = parseSymbolReferences("#sym:src/utils.ts:myFunction:42-58");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/utils.ts");
      assert.strictEqual(refs[0].symbolName, "myFunction");
      assert.strictEqual(refs[0].symbolKind, undefined);
      assert.strictEqual(refs[0].startLine, 42);
      assert.strictEqual(refs[0].endLine, 58);
    });

    test("parses an embedded symbol kind", () => {
      const generic = parseSymbolReferences(
        "#sym:src/utils.ts:myFunction:42-58"
      )[0];
      const kinded = parseSymbolReferences(
        "#sym.class:src/utils.ts:myFunction:42-58"
      )[0];

      assert.deepStrictEqual(
        {
          path: kinded.path,
          symbolName: kinded.symbolName,
          startLine: kinded.startLine,
          endLine: kinded.endLine,
        },
        {
          path: generic.path,
          symbolName: generic.symbolName,
          startLine: generic.startLine,
          endLine: generic.endLine,
        }
      );
      assert.strictEqual(kinded.symbolKind, "class");
    });

    test("parses #sym: reference with method syntax (parentheses)", () => {
      const refs = parseSymbolReferences(
        "#sym:src/class.ts:handleClick():100-125"
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].symbolName, "handleClick()");
      assert.strictEqual(refs[0].startLine, 100);
    });

    test("parses multiple #sym: references", () => {
      const prompt =
        "See #sym:src/a.ts:funcA:10-20 and #sym:src/b.ts:ClassB:50-75";
      const refs = parseSymbolReferences(prompt);
      assert.strictEqual(refs.length, 2);
      assert.strictEqual(refs[0].symbolName, "funcA");
      assert.strictEqual(refs[1].symbolName, "ClassB");
    });

    test("line number is stored as startLine", () => {
      const refs = parseSymbolReferences("#sym:src/file.ts:myVar:99-101");
      assert.strictEqual(refs[0].startLine, 99);
    });

    test("parses quoted path in #sym: reference", () => {
      const refs = parseSymbolReferences(
        '#sym:"path with spaces/example.py":ProductInSpace:11-24'
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "path with spaces/example.py");
      assert.strictEqual(refs[0].symbolName, "ProductInSpace");
      assert.strictEqual(refs[0].startLine, 11);
      assert.strictEqual(refs[0].endLine, 24);
    });

    test("parses quoted path in #sym: reference with method syntax", () => {
      const refs = parseSymbolReferences(
        '#sym:"my dir/class.ts":handleClick():50-65'
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "my dir/class.ts");
      assert.strictEqual(refs[0].symbolName, "handleClick()");
      assert.strictEqual(refs[0].startLine, 50);
    });

    test("does not include surrounding quotes in path when quoted", () => {
      const refs = parseSymbolReferences(
        '#sym:"path with spaces/file.ts":myFunc:1-4'
      );
      assert.strictEqual(refs.length, 1);
      assert.ok(
        !refs[0].path.startsWith('"'),
        "path should not start with a quote"
      );
      assert.ok(
        !refs[0].path.endsWith('"'),
        "path should not end with a quote"
      );
    });

    test("does not parse the obsolete start-line-only format", () => {
      assert.deepStrictEqual(
        parseSymbolReferences("#sym:src/utils.ts:myFunction:42"),
        []
      );
    });

    // A bare symbol name may contain anything except whitespace, ':' and '"'.
    // These all come straight off a language server and previously failed to
    // parse, so the reference rendered as a clickable chip but expanded to
    // nothing.
    for (const name of [
      "Foo<T>",
      "my-thing",
      "Foo.bar",
      "#private",
      "__init__",
      "operator[]",
    ]) {
      test(`parses a bare symbol name containing special characters: ${name}`, () => {
        const refs = parseSymbolReferences(`#sym:src/a.ts:${name}:1-2`);
        assert.strictEqual(refs.length, 1);
        assert.strictEqual(refs[0].symbolName, name);
      });
    }

    test("parses a quoted symbol name containing spaces", () => {
      const refs = parseSymbolReferences('#sym:src/a.ts:"get value":1-2');
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/a.ts");
      assert.strictEqual(refs[0].symbolName, "get value");
    });

    test("parses a quoted path and a quoted symbol name together", () => {
      const refs = parseSymbolReferences(
        '#sym:"C:/dev/my repo/a.ts":"My Heading":3-9'
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "C:/dev/my repo/a.ts");
      assert.strictEqual(refs[0].symbolName, "My Heading");
    });

    test("parses a kinded quoted path and symbol name", () => {
      const refs = parseSymbolReferences(
        '#sym.type-parameter:"C:/dev/my repo/a.ts":"My Type":3-9'
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].symbolKind, "type-parameter");
      assert.strictEqual(refs[0].path, "C:/dev/my repo/a.ts");
      assert.strictEqual(refs[0].symbolName, "My Type");
      assert.strictEqual(refs[0].startLine, 3);
      assert.strictEqual(refs[0].endLine, 9);
    });

    test("parses an unrecognized kind without changing the reference fields", () => {
      const refs = parseSymbolReferences("#sym.widget:src/a.ts:MyClass:1-2");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].symbolKind, "widget");
      assert.strictEqual(refs[0].path, "src/a.ts");
      assert.strictEqual(refs[0].symbolName, "MyClass");
      assert.strictEqual(refs[0].startLine, 1);
      assert.strictEqual(refs[0].endLine, 2);
    });

    test("parses a quoted Windows absolute path (drive colon)", () => {
      const refs = parseSymbolReferences('#sym:"C:\\dev\\repo\\a.ts":foo:1-1');
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "C:\\dev\\repo\\a.ts");
      assert.strictEqual(refs[0].symbolName, "foo");
    });

    test("a bare name never swallows surrounding prose", () => {
      // The permissive `[^:]+` name pattern matched "MyClass, at 12" here.
      assert.deepStrictEqual(
        parseSymbolReferences("see #sym:a.ts:MyClass, at 12:30-45 ok"),
        []
      );
    });

    test("a nearby time-like token does not disturb a real reference", () => {
      const refs = parseSymbolReferences(
        "the build ran 12:30-45 and #sym:a.ts:Foo:1-2 too"
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].symbolName, "Foo");
    });

    test("offsets cover the whole token including quoted fields", () => {
      const token = '#sym:"src/a b.ts":"get value":1-2';
      const text = `pre ${token} post`;
      const refs = parseSymbolReferences(text);
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(
        text.slice(refs[0].startOffset, refs[0].endOffset),
        token
      );
    });

    test("offsets cover the whole token including the embedded kind", () => {
      const token = '#sym.enum-member:"src/a b.ts":"get value":1-2';
      const text = `pre ${token} post`;
      const refs = parseSymbolReferences(text);
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(
        text.slice(refs[0].startOffset, refs[0].endOffset),
        token
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("parseDirectoryReferences", () => {
    test("returns only directory references", () => {
      const refs = parseDirectoryReferences(
        "See @src/utils/ and @src/helpers.ts"
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].isDirectory, true);
      assert.strictEqual(refs[0].path, "src/utils/");
    });

    test("returns empty array when no directory references", () => {
      const refs = parseDirectoryReferences("See @src/file.ts for details");
      assert.strictEqual(refs.length, 0);
    });

    test("returns all directory references when multiple present", () => {
      const refs = parseDirectoryReferences(
        "@src/ and @tests/ are the key dirs"
      );
      assert.strictEqual(refs.length, 2);
      assert.ok(refs.every((r) => r.isDirectory));
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("parseInlinePriorContextRefs", () => {
    test("returns empty array when no inline prior-context references exist", () => {
      const refs = parseInlinePriorContextRefs("normal prompt text");
      assert.deepStrictEqual(refs, []);
    });

    test("parses all keyword forms", () => {
      const refs = parseInlinePriorContextRefs(
        "$previous $all $finalStep $allFinalStep"
      );
      assert.deepStrictEqual(
        refs.map((match) => match.ref.kind),
        ["previous", "all", "finalStep", "allFinalStep"]
      );
      assert.deepStrictEqual(
        refs.map((match) => match.token),
        ["$previous", "$all", "$finalStep", "$allFinalStep"]
      );
    });

    test("does not truncate prior-context references before underscores", () => {
      for (const text of [
        "$all_files",
        "$previous_output",
        "$finalStep_1",
        "$step:1_x",
      ]) {
        assert.deepStrictEqual(parseInlinePriorContextRefs(text), [], text);
      }
    });

    test("keeps the bare previous fallback before prose colons", () => {
      assert.deepStrictEqual(
        parseInlinePriorContextRefs("$previous: fix it $previous:3x").map(
          (match) => match.token
        ),
        ["$previous", "$previous"]
      );
    });

    test("parses step range notation", () => {
      const refs = parseInlinePriorContextRefs("Use $step:3,1-2,2 please");
      assert.strictEqual(refs.length, 1);
      assert.deepStrictEqual(refs[0].ref, {
        kind: "step",
        indices: [1, 2, 3],
      });
      assert.strictEqual(refs[0].token, "$step:3,1-2,2");
    });

    test("ignores unknown tokens", () => {
      const refs = parseInlinePriorContextRefs(
        "$workflow-xyz:step:1 $unknown $previously $previous"
      );
      assert.strictEqual(refs.length, 1);
      assert.deepStrictEqual(refs[0].ref, { kind: "previous" });
    });

    test("skips invalid step ranges", () => {
      const refs = parseInlinePriorContextRefs("$step:abc $step:3-1 $step:2");
      assert.strictEqual(refs.length, 1);
      assert.deepStrictEqual(refs[0].ref, { kind: "step", indices: [2] });
    });

    test("allows punctuation after keyword tokens", () => {
      const refs = parseInlinePriorContextRefs("Use $previous, then continue.");
      assert.strictEqual(refs.length, 1);
      assert.deepStrictEqual(refs[0].ref, { kind: "previous" });
    });

    test("leaves a prose colon after bare prior-context keywords", () => {
      for (const keyword of ["previous", "all", "finalStep"]) {
        const text = `Here is $${keyword}: fix it`;
        const refs = parseInlinePriorContextRefs(text);
        assert.strictEqual(refs.length, 1, keyword);
        assert.strictEqual(refs[0].token, `$${keyword}`);
        assert.strictEqual(
          text.slice(text.indexOf(refs[0].token) + refs[0].token.length),
          ": fix it"
        );
      }
    });

    test("keeps the argument colon on step references", () => {
      assert.strictEqual(
        parseInlinePriorContextRefs("See $step:2: then continue")[0].token,
        "$step:2"
      );
    });

    test("treats a trailing comma on $step: as sentence punctuation", () => {
      const refs = parseInlinePriorContextRefs(
        "First review $step:1,4, then tell me which design you think is better"
      );
      assert.strictEqual(refs.length, 1);
      assert.deepStrictEqual(refs[0].ref, { kind: "step", indices: [1, 4] });
      assert.strictEqual(refs[0].token, "$step:1,4");
    });

    test("still rejects an interior empty range entry", () => {
      const refs = parseInlinePriorContextRefs("Use $step:1,,3 please");
      assert.strictEqual(refs.length, 0);
    });

    test("parses $previous:N as the last N outputs", () => {
      const text = "Look at $previous:3, then fix it";
      const refs = parseInlinePriorContextRefs(text);
      assert.strictEqual(refs.length, 1);
      assert.deepStrictEqual(refs[0].ref, { kind: "previous", count: 3 });
      assert.strictEqual(refs[0].token, "$previous:3");
      assert.strictEqual(
        text.slice(refs[0].startOffset, refs[0].endOffset),
        "$previous:3"
      );
    });

    test("drops a zero $previous count instead of guessing", () => {
      assert.deepStrictEqual(parseInlinePriorContextRefs("$previous:0"), []);
    });

    test("ignores $previous:N inside a fenced block", () => {
      assert.deepStrictEqual(
        parseInlinePriorContextRefs("```\n$previous:3\n```"),
        []
      );
    });
  });

  suite("parseInlinePriorContextBody / formatInlinePriorContextBody", () => {
    test("round-trips every body form through its canonical spelling", () => {
      for (const body of [
        "previous",
        "previous:3",
        "all",
        "finalStep",
        "allFinalStep",
        "step:1-3,5",
      ]) {
        const parsed = parseInlinePriorContextBody(body);
        assert.ok(parsed, body);
        assert.strictEqual(
          parseInlinePriorContextBody(formatInlinePriorContextBody(parsed.ref))
            ?.ref.kind,
          parsed.ref.kind,
          body
        );
      }
      assert.strictEqual(
        formatInlinePriorContextBody({ kind: "step", indices: [1, 2, 3, 5] }),
        "step:1,2,3,5"
      );
    });

    test("excludes a trailing step comma from the consumed length", () => {
      assert.strictEqual(
        parseInlinePriorContextBody("step:1,4,")?.length,
        "step:1,4".length
      );
    });

    test("rejects unknown and malformed bodies", () => {
      for (const body of ["previously", "previous:", "previous:-1", "step:"]) {
        assert.strictEqual(parseInlinePriorContextBody(body), null, body);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Every parser here masks fenced blocks and inline code spans internally
  // (FileReferenceParser.maskCodeRanges), so a trigger char that only
  // appears as literal pasted text inside a fence is never treated as a live
  // reference — regardless of which of the many call sites invokes the
  // parser directly (e.g. the editor's token-count hook, which never masks
  // itself).
  suite("triple-backtick fenced block suppression", () => {
    test("does not parse @ refs inside fenced blocks", () => {
      const text = "```\n@src/fenced.ts\n```\nUse @src/real.ts instead.";
      assert.deepStrictEqual(
        parseAtReferences(text).map((r) => r.path),
        ["src/real.ts"]
      );
    });

    test("does not parse #selection: refs inside fenced blocks", () => {
      const text =
        "```\n#selection:src/fenced.ts:1-2\n```\nSee #selection:src/real.ts:3-4.";
      assert.deepStrictEqual(
        parseSelectionReferences(text).map((r) => r.path),
        ["src/real.ts"]
      );
    });

    test("does not parse #sym: refs inside fenced blocks", () => {
      const text =
        "```\n#sym:src/fenced.ts:Foo:1-2\n```\nSee #sym:src/real.ts:Bar:3-4.";
      assert.deepStrictEqual(
        parseSymbolReferences(text).map((r) => r.symbolName),
        ["Bar"]
      );
    });

    test("does not parse ~diff/~staged/~stash/~<hash> refs inside fenced blocks", () => {
      const text = "```\n~diff\n```\nNow expand ~staged for real.";
      assert.deepStrictEqual(
        parseGitChangeReferences(text).map((r) => r.raw),
        ["~staged"]
      );
    });

    test("requires a boundary after each git-change reference", () => {
      const text =
        "~differently ~1500000x ~staged_files ~stash:1a ~diff. (~staged) ~stash:2, ~0123456.";
      assert.deepStrictEqual(
        parseGitChangeReferences(text).map((ref) => ref.raw),
        ["~diff", "~staged", "~stash:2", "~0123456"]
      );
    });

    test("does not parse $previous/$step refs inside fenced blocks", () => {
      const text = "```\n$previous\n```\nUse $step:1 instead.";
      assert.deepStrictEqual(
        parseInlinePriorContextRefs(text).map((m) => m.token),
        ["$step:1"]
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Fenced blocks and inline code spans are both literal. Each case runs
  // through every trigger parser that shares the scan, so they cannot drift.
  suite("code range suppression across parsers", () => {
    const LIVE = "@src/a.ts !TOKEN_A /skill:alpha $previous";
    const ALL_LIVE = ["!TOKEN_A", "$previous", "/skill:alpha", "@src/a.ts"];
    const FENCE = "```";

    function liveTokens(text: string): string[] {
      return [
        ...parseAtReferences(text).map((ref) =>
          text.slice(ref.startOffset, ref.endOffset)
        ),
        ...parseSecretReferences(text).map((ref) =>
          text.slice(ref.startOffset, ref.endOffset)
        ),
        ...scanCtrlYokeSlashTokens(text).map((token) => token.raw),
        ...parseInlinePriorContextRefs(text).map((match) => match.token),
      ].sort();
    }

    test("a mid-line triple backtick in prose does not shift a later fence", () => {
      assert.deepStrictEqual(
        parseAtReferences(
          "Use ``` fences for code. Review @src/a.ts now.\n```\nexample @x/y.ts\n```\n"
        ).map((ref) => ref.path),
        ["src/a.ts"]
      );
      assert.deepStrictEqual(
        liveTokens(
          `Use ${FENCE} fences. Review ${LIVE} now.\n${FENCE}\nexample @x/y.ts !TOKEN_B /skill:beta $all\n${FENCE}\n`
        ),
        ALL_LIVE
      );
    });

    test("a single-backtick span keeps every token literal", () => {
      assert.deepStrictEqual(liveTokens(`Quote \`${LIVE}\` then @src/b.ts`), [
        "@src/b.ts",
      ]);
    });

    test("a double-backtick span may contain a single backtick", () => {
      assert.deepStrictEqual(
        liveTokens(`Quote \`\`a \` ${LIVE}\`\` then !TOKEN_B`),
        ["!TOKEN_B"]
      );
    });

    test("an unpaired backtick masks nothing on its line or after it", () => {
      assert.deepStrictEqual(
        liveTokens("It's a ` stray @src/a.ts !TOKEN_A\n/skill:alpha $previous"),
        ALL_LIVE
      );
    });

    test("a span can close on the next line of the same paragraph", () => {
      assert.deepStrictEqual(
        liveTokens("Open `@src/a.ts !TOKEN_A\nclose /skill:alpha` $previous"),
        ["$previous"]
      );
    });

    test("an escaped backtick is not a delimiter", () => {
      assert.deepStrictEqual(
        liveTokens(`Escaped \\\` ${LIVE} \\\` and \`!TOKEN_B\``),
        ALL_LIVE
      );
    });

    test("a fence may be indented up to three spaces", () => {
      assert.deepStrictEqual(
        liveTokens(`   ${FENCE}\n${LIVE}\n   ${FENCE}\n@src/b.ts`),
        ["@src/b.ts"]
      );
    });

    test("a four-space-indented run is not a fence", () => {
      assert.deepStrictEqual(
        liveTokens(`    ${FENCE}\n${LIVE}\n    ${FENCE}\n`),
        ALL_LIVE
      );
    });

    test("an unclosed fence masks nothing", () => {
      assert.deepStrictEqual(liveTokens(`${FENCE}\n${LIVE}`), ALL_LIVE);
    });

    test("a generated literal fence keeps a backtick-laden value inert", () => {
      const value = `x \` y\n${FENCE}\n${LIVE}\n${FENCE}`;
      const authored = `${FENCE}\nlog:\nOUTPUT\n${FENCE}\nthen @src/b.ts`;
      const text = authored.replace(
        "OUTPUT",
        fenceLiteral(value, LITERAL_FENCE_INFO, authored)
      );
      assert.deepStrictEqual(liveTokens(text), ["@src/b.ts"]);

      const prose = `Run \`x\` output:\n${fenceLiteral(value, LITERAL_FENCE_INFO)}\n$all`;
      assert.deepStrictEqual(liveTokens(prose), ["$all"]);
    });

    test("a generated fence does not close an unclosed authored fence", () => {
      const authored =
        "```\nReview @src/a.ts\n$endCondition:stdout\nReview @src/b.ts\n$preCondition:stdout";
      const withEndCondition = authored.replace(
        "$endCondition:stdout",
        fenceLiteral("end condition output", LITERAL_FENCE_INFO, authored)
      );
      const substituted = withEndCondition.replace(
        "$preCondition:stdout",
        fenceLiteral("pre condition output", LITERAL_FENCE_INFO, authored)
      );

      assert.deepStrictEqual(
        parseAtReferences(substituted).map((reference) => reference.path),
        ["src/a.ts", "src/b.ts"]
      );
    });

    test("fencesOnly leaves inline spans unmasked", () => {
      assert.strictEqual(
        maskCodeRanges(`\`@src/a.ts\`\n${FENCE}\n@src/b.ts\n${FENCE}`, {
          fencesOnly: true,
        }),
        `\`@src/a.ts\`\n${FENCE}\n\x00src\x00b.ts\n${FENCE}`
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("parseAllFileReferences", () => {
    test("returns empty array for empty prompt", () => {
      const refs = parseAllFileReferences("");
      assert.deepStrictEqual(refs, []);
    });

    test("combines @path, #selection:, and #sym: references", () => {
      const prompt = [
        "Look at @src/utils.ts",
        "and #selection:src/types.ts:1-50",
        "and #sym:src/index.ts:main:10-20",
      ].join(" ");
      const refs = parseAllFileReferences(prompt);
      // Should contain all three types
      assert.strictEqual(refs.length, 3);
    });

    test("includes both files and directories", () => {
      const refs = parseAllFileReferences(
        "See @src/ for the dir and @src/index.ts for the file"
      );
      assert.strictEqual(refs.length, 2);
      const dirs = refs.filter((r) => r.isDirectory);
      const files = refs.filter((r) => !r.isDirectory && !r.symbolName);
      assert.strictEqual(dirs.length, 1);
      assert.strictEqual(files.length, 1);
    });

    test("returns unique syntaxes from mixed prompt", () => {
      const prompt =
        "@src/a.ts #selection:src/b.ts:1-5 #sym:src/c.ts:myFunc:10-20";
      const refs = parseAllFileReferences(prompt);
      assert.strictEqual(refs.length, 3);
    });

    test("orders mixed references by token appearance, not earlier prose paths", () => {
      const prompt =
        "src/a.ts is mentioned in prose first; then #sym:src/b.ts:Foo:1-5, " +
        "@src/a.ts, and #selection:src/c.ts:3-4";

      const refs = parseAllFileReferences(prompt);

      assert.deepStrictEqual(
        refs.map((ref) => [ref.path, ref.symbolName]),
        [
          ["src/b.ts", "Foo"],
          ["src/a.ts", undefined],
          ["src/c.ts", undefined],
        ]
      );
    });

    test("preserves ./ and ../ paths through parse and rewrite round trips", () => {
      const prompts = [
        "@./bare.png",
        "@../bare.png",
        '@"./space one.png"',
        '@"../space two.png"',
        "#selection:./bare.ts:1-2",
        '#selection:"../space two.ts":3-4',
        "#sym.class:./bare.ts:Thing:5-6",
        '#sym.method:"../space two.ts":"My Symbol":7-8',
      ];

      for (const prompt of prompts) {
        const [ref] = parseAllFileReferences(prompt);
        assert.ok(ref);
        const rewritten = ref.symbolName
          ? buildSymbolReference(
              ref.path,
              ref.symbolName,
              ref.startLine!,
              ref.endLine!,
              ref.symbolKind
            )
          : ref.startLine !== undefined && ref.endLine !== undefined
            ? buildSelectionReference(ref.path, ref.startLine, ref.endLine)
            : buildFileReference(ref.path);

        assert.strictEqual(rewritten, prompt);
        assert.deepStrictEqual(parseAllFileReferences(rewritten)[0], ref);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("prior-context token ref encoding", () => {
    test("round-trips a simple body and step count", () => {
      const encoded = encodePriorContextTokenRef("previous", 3);
      assert.deepStrictEqual(decodePriorContextTokenRef(encoded), {
        body: "previous",
        stepCount: 3,
      });
    });

    test("round-trips a step-range body containing separators", () => {
      const encoded = encodePriorContextTokenRef("step:1,3-5", 12);
      assert.deepStrictEqual(decodePriorContextTokenRef(encoded), {
        body: "step:1,3-5",
        stepCount: 12,
      });
    });

    test("distinct step counts encode to distinct refs (cache safety)", () => {
      assert.notStrictEqual(
        encodePriorContextTokenRef("previous", 2),
        encodePriorContextTokenRef("previous", 3)
      );
    });

    test("returns null for a non-prior-context reference", () => {
      assert.strictEqual(decodePriorContextTokenRef("@src/index.ts"), null);
      assert.strictEqual(decodePriorContextTokenRef("~diff"), null);
    });
  });
});
