import * as assert from "assert";
import { suite, test } from "mocha";
import {
  parseAtReferences,
  parseSelectionReferences,
  parseSymbolReferences,
  parseDirectoryReferences,
  parseAllFileReferences,
  parseInlinePriorContextRefs,
} from "../../utils/FileReferenceParser";

suite("FileReferenceParser", () => {
  // ──────────────────────────────────────────────────────────────────────────
  suite("parseAtReferences", () => {
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

    test("parses Windows-style file path", () => {
      const refs = parseAtReferences("See @src\\utils\\helper.ts");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src\\utils\\helper.ts");
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

    test("strips trailing backticks from inline-code @path references", () => {
      const refs = parseAtReferences("Check `@src/file.ts` in the prompt");
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
      assert.strictEqual(refs[0].startLine, 42);
      assert.strictEqual(refs[0].endLine, 58);
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
  });
});
