import * as assert from "assert";
import { suite, test } from "mocha";
import {
  parseAtReferences,
  parseFileReferences,
  parseSymbolReferences,
  parseDirectoryReferences,
  parseAllFileReferences,
  FileReference,
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
  suite("parseFileReferences", () => {
    test("returns empty array for prompt with no #file: references", () => {
      const refs = parseFileReferences("just normal text");
      assert.deepStrictEqual(refs, []);
    });

    test("parses #file: reference with line range", () => {
      const refs = parseFileReferences(
        "See #file:src/utils.ts:10-20 for details."
      );
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/utils.ts");
      assert.strictEqual(refs[0].startLine, 10);
      assert.strictEqual(refs[0].endLine, 20);
    });

    test("parses quoted path in #file: reference", () => {
      const refs = parseFileReferences('#file:"path with spaces/file.ts":5-15');
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "path with spaces/file.ts");
      assert.strictEqual(refs[0].startLine, 5);
      assert.strictEqual(refs[0].endLine, 15);
    });

    test("parses multiple #file: references", () => {
      const prompt = "Look at #file:src/a.ts:1-10 and #file:src/b.ts:20-30";
      const refs = parseFileReferences(prompt);
      assert.strictEqual(refs.length, 2);
      assert.strictEqual(refs[0].path, "src/a.ts");
      assert.strictEqual(refs[0].startLine, 1);
      assert.strictEqual(refs[0].endLine, 10);
      assert.strictEqual(refs[1].path, "src/b.ts");
      assert.strictEqual(refs[1].startLine, 20);
      assert.strictEqual(refs[1].endLine, 30);
    });

    test("ignores #file: without line range", () => {
      // Per the spec, #file:path (without line range) is DEPRECATED — should not match
      const refs = parseFileReferences("#file:src/utils.ts");
      assert.strictEqual(refs.length, 0);
    });

    test("line range values are parsed as numbers", () => {
      const refs = parseFileReferences("#file:src/file.ts:100-200");
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
      const refs = parseSymbolReferences("#sym:src/utils.ts:myFunction:42");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].path, "src/utils.ts");
      assert.strictEqual(refs[0].symbolName, "myFunction");
      assert.strictEqual(refs[0].startLine, 42);
    });

    test("parses #sym: reference with method syntax (parentheses)", () => {
      const refs = parseSymbolReferences("#sym:src/class.ts:handleClick():100");
      assert.strictEqual(refs.length, 1);
      assert.strictEqual(refs[0].symbolName, "handleClick()");
      assert.strictEqual(refs[0].startLine, 100);
    });

    test("parses multiple #sym: references", () => {
      const prompt = "See #sym:src/a.ts:funcA:10 and #sym:src/b.ts:ClassB:50";
      const refs = parseSymbolReferences(prompt);
      assert.strictEqual(refs.length, 2);
      assert.strictEqual(refs[0].symbolName, "funcA");
      assert.strictEqual(refs[1].symbolName, "ClassB");
    });

    test("line number is stored as startLine", () => {
      const refs = parseSymbolReferences("#sym:src/file.ts:myVar:99");
      assert.strictEqual(refs[0].startLine, 99);
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
  suite("parseAllFileReferences", () => {
    test("returns empty array for empty prompt", () => {
      const refs = parseAllFileReferences("");
      assert.deepStrictEqual(refs, []);
    });

    test("combines @path, #file:, and #sym: references", () => {
      const prompt = [
        "Look at @src/utils.ts",
        "and #file:src/types.ts:1-50",
        "and #sym:src/index.ts:main:10",
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
      const prompt = "@src/a.ts #file:src/b.ts:1-5 #sym:src/c.ts:myFunc:10";
      const refs = parseAllFileReferences(prompt);
      assert.strictEqual(refs.length, 3);
    });
  });
});
