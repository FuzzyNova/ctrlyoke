import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { ContextExpander } from "../utils/ContextExpander";

suite("ContextExpander.expandContextSplit", () => {
  let workspaceRoot: string;

  function freshWorkspace(): string {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-"));
    return workspaceRoot;
  }

  afterEach(() => {
    try {
      if (workspaceRoot) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("no references", () => {
    test("returns empty result for prompt with no @-references", async () => {
      const root = freshWorkspace();
      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        "Just a plain text prompt with no file references."
      );
      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("returns empty result for empty string", async () => {
      const root = freshWorkspace();
      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit("");
      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("full-file @path references", () => {
    test("puts full-file @path ref into directFileRefs as absolute path", async () => {
      const root = freshWorkspace();
      // Create an actual file to reference
      const filePath = path.join(root, "src", "helper.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "export const x = 1;\n");

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        "Please look at @src/helper.ts for context."
      );

      assert.strictEqual(result.directFileRefs.length, 1);
      assert.strictEqual(result.directFileRefs[0], filePath);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("puts multiple full-file refs into directFileRefs", async () => {
      const root = freshWorkspace();
      const fileA = path.join(root, "a.ts");
      const fileB = path.join(root, "b.ts");
      fs.writeFileSync(fileA, "const a = 1;\n");
      fs.writeFileSync(fileB, "const b = 2;\n");

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        "Look at @a.ts and @b.ts please."
      );

      assert.strictEqual(result.directFileRefs.length, 2);
      assert.ok(result.directFileRefs.includes(fileA));
      assert.ok(result.directFileRefs.includes(fileB));
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("deduplicates repeated references to the same file", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "utils.ts");
      fs.writeFileSync(filePath, "export const util = () => {};\n");

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        "See @utils.ts and also @utils.ts again."
      );

      assert.strictEqual(result.directFileRefs.length, 1);
      assert.strictEqual(result.directFileRefs[0], filePath);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("line-range #selection: references", () => {
    test("puts line-range ref into excerptBlocks (not directFileRefs)", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "sample.ts");
      fs.writeFileSync(
        filePath,
        ["line one", "line two", "line three", "line four", "line five"].join(
          "\n"
        )
      );

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        "Focus on #selection:sample.ts:2-4"
      );

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.ok(
        result.excerptBlocks.length > 0,
        "excerptBlocks should have content"
      );
      assert.ok(
        result.excerptBlocks.includes("<attachment"),
        "should be wrapped in <attachment> XML"
      );
    });

    test("line-range excerpt includes line numbers in N→content format", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "numbered.ts");
      fs.writeFileSync(
        filePath,
        [
          "alpha", // line 1
          "beta", // line 2
          "gamma", // line 3
          "delta", // line 4
        ].join("\n")
      );

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        "Check #selection:numbered.ts:2-3"
      );

      assert.ok(
        result.excerptBlocks.includes("    2→beta"),
        `Expected '    2→beta' in excerpt, got: ${result.excerptBlocks}`
      );
      assert.ok(
        result.excerptBlocks.includes("    3→gamma"),
        `Expected '    3→gamma' in excerpt, got: ${result.excerptBlocks}`
      );
    });

    test("line numbers in excerpt are 1-based and match source positions", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "src.ts");
      const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
      fs.writeFileSync(filePath, lines.join("\n"));

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        "See #selection:src.ts:5-7"
      );

      assert.ok(
        result.excerptBlocks.includes("    5→line5"),
        "Should have line 5 with number prefix"
      );
      assert.ok(
        result.excerptBlocks.includes("    6→line6"),
        "Should have line 6 with number prefix"
      );
      assert.ok(
        result.excerptBlocks.includes("    7→line7"),
        "Should have line 7 with number prefix"
      );
      // Lines outside the range should not appear
      assert.ok(
        !result.excerptBlocks.includes("    4→"),
        "Should not include line 4"
      );
      assert.ok(
        !result.excerptBlocks.includes("    8→"),
        "Should not include line 8"
      );
    });

    test("excerpt does not include line 1 reference when range starts at line 5", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "offset.ts");
      const lines = Array.from({ length: 8 }, (_, i) => `content${i + 1}`);
      fs.writeFileSync(filePath, lines.join("\n"));

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        "Excerpt: #selection:offset.ts:5-6"
      );

      assert.ok(
        result.excerptBlocks.includes("    5→content5"),
        "Line 5 should have correct number"
      );
      assert.ok(
        result.excerptBlocks.includes("    6→content6"),
        "Line 6 should have correct number"
      );
      assert.ok(
        !result.excerptBlocks.includes("    1→"),
        "Line 1 should not appear for range 5-6"
      );
    });
  });

  suite("line-range #sym: references", () => {
    test("uses the encoded range without runtime symbol discovery", async () => {
      const root = freshWorkspace();
      fs.writeFileSync(
        path.join(root, "symbol.ts"),
        ["before", "start", "middle", "end", "after"].join("\n")
      );

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        "Check #sym:symbol.ts:notARealSymbol:2-4"
      );

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.ok(result.excerptBlocks.includes("    2→start"));
      assert.ok(result.excerptBlocks.includes("    4→end"));
      assert.ok(!result.excerptBlocks.includes("    5→after"));
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("mixed references", () => {
    test("separates full-file refs from line-range refs", async () => {
      const root = freshWorkspace();
      const fullFile = path.join(root, "full.ts");
      const rangeFile = path.join(root, "range.ts");
      fs.writeFileSync(fullFile, "export const full = true;\n");
      fs.writeFileSync(rangeFile, ["lineA", "lineB", "lineC"].join("\n"));

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        "Use @full.ts and focus on #selection:range.ts:1-2"
      );

      // Full-file ref → directFileRefs
      assert.strictEqual(result.directFileRefs.length, 1);
      assert.strictEqual(result.directFileRefs[0], fullFile);

      // Line-range ref → excerptBlocks
      assert.ok(result.excerptBlocks.length > 0);
      assert.ok(result.excerptBlocks.includes("    1→lineA"));
      assert.ok(result.excerptBlocks.includes("    2→lineB"));
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("triple-backtick fenced block suppression", () => {
    test("does not expand @, #selection, #sym, or ~ refs inside fenced blocks", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "inside.ts");
      fs.writeFileSync(filePath, "export function inside() {}\n");

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        [
          "```ts",
          "@inside.ts",
          "#selection:inside.ts:1-1",
          "#sym:inside.ts:inside:1-1",
          "~diff",
          "```",
        ].join("\n")
      );

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("expands only references outside fenced blocks", async () => {
      const root = freshWorkspace();
      const outsideFile = path.join(root, "outside.ts");
      const insideFile = path.join(root, "inside.ts");
      const rangeFile = path.join(root, "range.ts");
      fs.writeFileSync(outsideFile, "export const outside = true;\n");
      fs.writeFileSync(insideFile, "export const inside = true;\n");
      fs.writeFileSync(rangeFile, ["one", "two", "three", "four"].join("\n"));

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        [
          "Use @outside.ts and #selection:range.ts:1-2.",
          "```",
          "@inside.ts",
          "#selection:range.ts:3-4",
          "```",
        ].join("\n")
      );

      assert.deepStrictEqual(result.directFileRefs, [outsideFile]);
      assert.ok(result.excerptBlocks.includes("    1→one"));
      assert.ok(result.excerptBlocks.includes("    2→two"));
      assert.ok(!result.excerptBlocks.includes("    3→three"));
      assert.ok(!result.excerptBlocks.includes("    4→four"));
    });

    test("suppresses references across multiple fenced blocks", async () => {
      const root = freshWorkspace();
      fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
      fs.writeFileSync(path.join(root, "b.ts"), "export const b = 2;\n");

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        [
          "```",
          "@a.ts",
          "```",
          "plain text",
          "```js",
          "@b.ts",
          "#selection:b.ts:1-1",
          "```",
        ].join("\n")
      );

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("treats unclosed fenced blocks as normal text and still expands references", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "unclosed.ts");
      fs.writeFileSync(filePath, "export const value = 1;\n");

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        ["Here is an unclosed fence:", "```ts", "@unclosed.ts"].join("\n")
      );

      assert.deepStrictEqual(result.directFileRefs, [filePath]);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("does not suppress references inside single-backtick inline code", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "inline.ts");
      fs.writeFileSync(filePath, "export const inline = true;\n");

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        "Check `@inline.ts` while reviewing this change."
      );

      assert.deepStrictEqual(result.directFileRefs, [filePath]);
      assert.strictEqual(result.excerptBlocks, "");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("path traversal protection", () => {
    let outsideDir: string;

    afterEach(() => {
      try {
        if (outsideDir) {
          fs.rmSync(outsideDir, { recursive: true, force: true });
        }
      } catch {
        // best-effort
      }
    });

    test("blocks a full-file @path ref that escapes the workspace via '..'", async () => {
      const root = freshWorkspace();
      outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-outside-"));
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "TOP SECRET\n");
      const traversal = path.relative(
        root,
        path.join(outsideDir, "secret.txt")
      );

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(`@${traversal}`);

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("blocks an absolute-path @path ref outside the workspace", async () => {
      const root = freshWorkspace();
      outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-outside-"));
      const absPath = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(absPath, "TOP SECRET\n");

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(`@${absPath}`);

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("blocks a #selection: range ref that escapes the workspace via '..'", async () => {
      const root = freshWorkspace();
      outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-outside-"));
      fs.writeFileSync(
        path.join(outsideDir, "secret.txt"),
        "TOP\nSECRET\nDATA\n"
      );
      const traversal = path.relative(
        root,
        path.join(outsideDir, "secret.txt")
      );

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        `#selection:${traversal}:1-2`
      );

      assert.strictEqual(result.excerptBlocks, "");
      assert.ok(!result.excerptBlocks.includes("TOP"));
    });

    test("still allows a legitimate in-workspace reference alongside a blocked one", async () => {
      const root = freshWorkspace();
      outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-outside-"));
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "TOP SECRET\n");
      const traversal = path.relative(
        root,
        path.join(outsideDir, "secret.txt")
      );
      const insideFile = path.join(root, "inside.ts");
      fs.writeFileSync(insideFile, "export const inside = true;\n");

      const expander = new ContextExpander(root);
      const result = await expander.expandContextSplit(
        `@${traversal} and @inside.ts`
      );

      assert.deepStrictEqual(result.directFileRefs, [insideFile]);
    });
  });
});

suite("ContextExpander.expandContext", () => {
  let workspaceRoot: string;

  function freshWorkspace(): string {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-"));
    return workspaceRoot;
  }

  afterEach(() => {
    try {
      if (workspaceRoot) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }
  });

  test("keeps fenced references literal while expanding outside references", async () => {
    const root = freshWorkspace();
    fs.writeFileSync(
      path.join(root, "outside.ts"),
      "export const outside = 1;\n"
    );
    fs.writeFileSync(
      path.join(root, "inside.ts"),
      "export const inside = 2;\n"
    );

    const expander = new ContextExpander(root);
    const result = await expander.expandContext(
      ["Review @outside.ts carefully.", "```", "@inside.ts", "```"].join("\n")
    );

    assert.ok(result.includes('<attachment id="file:outside.ts">'));
    assert.ok(!result.includes('<attachment id="file:inside.ts">'));
    assert.ok(result.includes("```"));
    assert.ok(result.includes("@inside.ts"));
  });
});
