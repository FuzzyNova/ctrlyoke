import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { ContextExpander } from "../utils/ContextExpander";
import {
  parseSelectionReferences,
  parseSymbolReferences,
} from "../utils/FileReferenceParser";

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

  // ──────────────────────────────────────────────────────────────────────────
  suite("multi-root workspace trust", () => {
    let secondRoot: string;

    afterEach(() => {
      try {
        if (secondRoot) {
          fs.rmSync(secondRoot, { recursive: true, force: true });
        }
      } catch {
        // best-effort
      }
    });

    test("allows a full-file ref into a second trusted root that is not a descendant of the primary root", async () => {
      const root = freshWorkspace();
      secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-second-"));
      const secondFile = path.join(secondRoot, "b.ts");
      fs.writeFileSync(secondFile, "export const b = true;\n");
      const relativeFromPrimary = path.relative(root, secondFile);

      // Without the second root registered as trusted, the same reference
      // must be rejected (this is the regression the multi-root fix closes).
      const untrustedExpander = new ContextExpander(root);
      const untrustedResult = await untrustedExpander.expandContextSplit(
        `@${relativeFromPrimary}`
      );
      assert.deepStrictEqual(untrustedResult.directFileRefs, []);

      const trustedExpander = new ContextExpander(root, [root, secondRoot]);
      const trustedResult = await trustedExpander.expandContextSplit(
        `@${relativeFromPrimary}`
      );
      assert.deepStrictEqual(trustedResult.directFileRefs, [secondFile]);
    });

    test("allows a @dir/ reference into a second trusted root", async () => {
      const root = freshWorkspace();
      secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-second-"));
      fs.mkdirSync(path.join(secondRoot, "sub"));
      fs.writeFileSync(path.join(secondRoot, "sub", "c.ts"), "// c\n");
      const relativeDir = path.relative(root, path.join(secondRoot, "sub"));

      const expander = new ContextExpander(root, [root, secondRoot]);
      const result = await expander.expandContextSplit(`@${relativeDir}/`);

      assert.ok(result.excerptBlocks.includes("c.ts"));
      assert.ok(!result.excerptBlocks.includes("blocked"));
    });

    test("still blocks a reference outside every trusted root", async () => {
      const root = freshWorkspace();
      secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-second-"));
      const untrustedDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "fp-ctx-untrusted-")
      );
      fs.writeFileSync(path.join(untrustedDir, "secret.txt"), "TOP SECRET\n");
      const traversal = path.relative(
        root,
        path.join(untrustedDir, "secret.txt")
      );

      try {
        const expander = new ContextExpander(root, [root, secondRoot]);
        const result = await expander.expandContextSplit(`@${traversal}`);

        assert.deepStrictEqual(result.directFileRefs, []);
      } finally {
        fs.rmSync(untrustedDir, { recursive: true, force: true });
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Allowed external file roots (dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md).
  // Callers widen the same `additionalTrustedRoots` list with the effective
  // approved external roots — ContextExpander itself needs no new branch, so
  // these tests exercise the identical mechanism as "multi-root workspace
  // trust" above, just naming the intent explicitly.
  suite("allowed external file roots", () => {
    let externalRoot: string;

    afterEach(() => {
      try {
        if (externalRoot) {
          fs.rmSync(externalRoot, { recursive: true, force: true });
        }
      } catch {
        // best-effort
      }
    });

    test("attaches a trusted external full-file reference", async () => {
      const root = freshWorkspace();
      externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-ext-"));
      const externalFile = path.join(externalRoot, "session.jsonl");
      fs.writeFileSync(externalFile, '{"event":"start"}\n');

      const expander = new ContextExpander(root, [root, externalRoot]);
      const result = await expander.expandContextSplit(`@"${externalFile}"`);

      assert.deepStrictEqual(result.directFileRefs, [externalFile]);
    });

    test("attaches a trusted external selection excerpt", async () => {
      const root = freshWorkspace();
      externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-ext-"));
      const externalFile = path.join(externalRoot, "debug.log");
      fs.writeFileSync(externalFile, "line1\nline2\nline3\n");

      const expander = new ContextExpander(root, [root, externalRoot]);
      const result = await expander.expandContextSplit(
        `#selection:"${externalFile}":1-2`
      );

      assert.ok(result.excerptBlocks.includes("line1"));
      assert.ok(result.excerptBlocks.includes("line2"));
    });

    test("attaches a trusted external directory listing", async () => {
      const root = freshWorkspace();
      externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-ext-"));
      fs.writeFileSync(path.join(externalRoot, "notes.txt"), "hi\n");

      const expander = new ContextExpander(root, [root, externalRoot]);
      const result = await expander.expandContextSplit(`@"${externalRoot}/"`);

      assert.ok(result.excerptBlocks.includes("notes.txt"));
      assert.ok(!result.excerptBlocks.includes("blocked"));
    });

    test("blocks an unapproved external full-file reference", async () => {
      const root = freshWorkspace();
      externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-ext-"));
      const externalFile = path.join(externalRoot, "session.jsonl");
      fs.writeFileSync(externalFile, '{"event":"start"}\n');

      // externalRoot intentionally NOT included in additionalTrustedRoots —
      // simulates a root that is configured but not yet approved.
      const expander = new ContextExpander(root, [root]);
      const result = await expander.expandContextSplit(`@"${externalFile}"`);

      assert.deepStrictEqual(result.directFileRefs, []);
    });

    test("blocks an unapproved external directory listing", async () => {
      const root = freshWorkspace();
      externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-ext-"));
      fs.writeFileSync(path.join(externalRoot, "notes.txt"), "hi\n");

      const expander = new ContextExpander(root, [root]);
      const result = await expander.expandContextSplit(`@"${externalRoot}/"`);

      assert.ok(result.excerptBlocks.includes("blocked"));
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("named-root (folder-name-prefixed) resolution", () => {
    let secondRoot: string;

    afterEach(() => {
      try {
        if (secondRoot) {
          fs.rmSync(secondRoot, { recursive: true, force: true });
        }
      } catch {
        // best-effort
      }
    });

    test("resolves a folder-name-prefixed ref against the matching named root", async () => {
      const root = freshWorkspace();
      secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-second-"));
      const secondFile = path.join(secondRoot, "b.ts");
      fs.writeFileSync(secondFile, "export const b = true;\n");

      const expander = new ContextExpander(
        root,
        [root, secondRoot],
        [
          { name: "root1", fsPath: root },
          { name: "root2", fsPath: secondRoot },
        ]
      );
      const result = await expander.expandContextSplit("@root2/b.ts");

      assert.deepStrictEqual(result.directFileRefs, [secondFile]);
    });

    test("unprefixed ref still resolves against the primary root", async () => {
      const root = freshWorkspace();
      secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-second-"));
      const primaryFile = path.join(root, "a.ts");
      fs.writeFileSync(primaryFile, "export const a = true;\n");

      const expander = new ContextExpander(
        root,
        [root, secondRoot],
        [
          { name: "root1", fsPath: root },
          { name: "root2", fsPath: secondRoot },
        ]
      );
      const result = await expander.expandContextSplit("@a.ts");

      assert.deepStrictEqual(result.directFileRefs, [primaryFile]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("effectiveAbsolute rendering", () => {
    test("renders the as-typed relative path in the excerpt when effectiveAbsolute is false", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "a.ts");
      fs.writeFileSync(filePath, "line1\nline2\nline3\n");

      const expander = new ContextExpander(root, [root], [], false);
      const result = await expander.expandContextSplit("#selection:a.ts:1-2");

      assert.ok(result.excerptBlocks.includes("Excerpt from a.ts"));
      assert.ok(!result.excerptBlocks.includes(filePath));
    });

    test("renders the resolved absolute path in the excerpt when effectiveAbsolute is true", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "a.ts");
      fs.writeFileSync(filePath, "line1\nline2\nline3\n");

      const expander = new ContextExpander(root, [root], [], true);
      const result = await expander.expandContextSplit("#selection:a.ts:1-2");

      assert.ok(result.excerptBlocks.includes(`Excerpt from ${filePath}`));
      // Attachment id stays as-typed (relative) even when rendering absolute.
      assert.ok(result.excerptBlocks.includes('id="selection:a.ts:1-2"'));
    });

    test("renders the resolved absolute directory path in the body when effectiveAbsolute is true", async () => {
      const root = freshWorkspace();
      fs.mkdirSync(path.join(root, "sub"));
      fs.writeFileSync(path.join(root, "sub", "c.ts"), "// c\n");

      const expander = new ContextExpander(root, [root], [], true);
      const result = await expander.expandContextSplit("@sub/");

      const absoluteDir = path.join(root, "sub");
      assert.ok(result.excerptBlocks.includes(absoluteDir));
      assert.ok(result.excerptBlocks.includes('id="directory:sub"'));
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

suite("ContextExpander.sanitizeReferences", () => {
  let workspaceRoot: string;
  let secondRoot: string;

  function freshWorkspace(): string {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-"));
    return workspaceRoot;
  }

  afterEach(() => {
    try {
      if (workspaceRoot) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
      }
      if (secondRoot) {
        fs.rmSync(secondRoot, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }
  });

  test("leaves text untouched when there are no references", async () => {
    const root = freshWorkspace();
    const expander = new ContextExpander(root, [root], [], true);
    const text = "Please implement the feature described above.";

    assert.strictEqual(await expander.sanitizeReferences(text), text);
  });

  test("single-root, effectiveAbsolute false: leaves an unprefixed @ref textually unchanged", async () => {
    const root = freshWorkspace();
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");

    const expander = new ContextExpander(root, [root], [], false);
    const result = await expander.sanitizeReferences(
      "Please review @a.ts for issues."
    );

    assert.strictEqual(result, "Please review @a.ts for issues.");
  });

  test("multi-root, effectiveAbsolute true: rewrites a folder-prefixed @ref to its absolute path", async () => {
    const root = freshWorkspace();
    secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-second-"));
    const secondFile = path.join(secondRoot, "b.ts");
    fs.writeFileSync(secondFile, "export const b = true;\n");

    const expander = new ContextExpander(
      root,
      [root, secondRoot],
      [
        { name: "root1", fsPath: root },
        { name: "root2", fsPath: secondRoot },
      ],
      true
    );
    const result = await expander.sanitizeReferences(
      "Please fix @root2/b.ts before merging."
    );

    assert.strictEqual(result, `Please fix @${secondFile} before merging.`);
  });

  test("multi-root, effectiveAbsolute true: rewrites a folder-prefixed #sym: ref to its absolute path", async () => {
    const root = freshWorkspace();
    secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-second-"));
    const secondFile = path.join(secondRoot, "b.ts");
    fs.writeFileSync(secondFile, "export function foo() {}\n");

    const expander = new ContextExpander(
      root,
      [root, secondRoot],
      [
        { name: "root1", fsPath: root },
        { name: "root2", fsPath: secondRoot },
      ],
      true
    );
    const result = await expander.sanitizeReferences(
      "When #sym:root2/b.ts:foo:1-1 runs, log the result."
    );

    // Quoted because an absolute path contains the drive colon, which is also
    // the field separator — bare, the rewritten token parses back as nothing.
    assert.strictEqual(
      result,
      `When #sym:"${secondFile}":foo:1-1 runs, log the result.`
    );
    assert.deepStrictEqual(
      parseSymbolReferences(result).map((ref) => [ref.path, ref.symbolName]),
      [[secondFile, "foo"]],
      "rewritten #sym: token must round-trip through the runtime parser"
    );
  });

  test("multi-root, effectiveAbsolute true: rewrites a folder-prefixed #selection: ref to its absolute path", async () => {
    const root = freshWorkspace();
    secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-second-"));
    const secondFile = path.join(secondRoot, "b.ts");
    fs.writeFileSync(secondFile, "line1\nline2\n");

    const expander = new ContextExpander(
      root,
      [root, secondRoot],
      [
        { name: "root1", fsPath: root },
        { name: "root2", fsPath: secondRoot },
      ],
      true
    );
    const result = await expander.sanitizeReferences(
      "See #selection:root2/b.ts:1-2 for context."
    );

    assert.strictEqual(
      result,
      `See #selection:"${secondFile}":1-2 for context.`
    );
    assert.deepStrictEqual(
      parseSelectionReferences(result).map((ref) => ref.path),
      [secondFile],
      "rewritten #selection: token must round-trip through the runtime parser"
    );
  });

  test("single-root, effectiveAbsolute false: leaves #sym:/#selection: refs unchanged", async () => {
    const root = freshWorkspace();
    fs.writeFileSync(path.join(root, "a.ts"), "line1\nline2\n");

    const expander = new ContextExpander(root, [root], [], false);
    const text = "See #selection:a.ts:1-2 and #sym:a.ts:foo:1-2 here.";

    assert.strictEqual(await expander.sanitizeReferences(text), text);
  });

  test("applies a custom formatFileRef (e.g. Codex dropping the @) even in single-root", async () => {
    const root = freshWorkspace();
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");

    const expander = new ContextExpander(root, [root], [], false);
    const result = await expander.sanitizeReferences(
      "Please review @a.ts for issues.",
      (quotedPath) => quotedPath
    );

    assert.strictEqual(result, "Please review a.ts for issues.");
  });

  test("leaves an unreadable/nonexistent reference untouched", async () => {
    const root = freshWorkspace();
    const text = "See @missing.ts for details.";

    const expander = new ContextExpander(root, [root], [], true);
    assert.strictEqual(await expander.sanitizeReferences(text), text);
  });

  test("leaves directory refs untouched", async () => {
    const root = freshWorkspace();
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "c.ts"), "// c\n");

    const expander = new ContextExpander(root, [root], [], true);
    const text = "List everything under @sub/ please.";

    assert.strictEqual(await expander.sanitizeReferences(text), text);
  });

  test("leaves references inside fenced code blocks untouched", async () => {
    const root = freshWorkspace();
    secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-second-"));
    const secondFile = path.join(secondRoot, "b.ts");
    fs.writeFileSync(secondFile, "export const b = true;\n");

    const expander = new ContextExpander(
      root,
      [root, secondRoot],
      [
        { name: "root1", fsPath: root },
        { name: "root2", fsPath: secondRoot },
      ],
      true
    );
    const text = ["Example:", "```", "@root2/b.ts", "```"].join("\n");

    assert.strictEqual(await expander.sanitizeReferences(text), text);
  });

  test("preserves surrounding prose and trailing punctuation", async () => {
    const root = freshWorkspace();
    secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-ctx-second-"));
    const secondFile = path.join(secondRoot, "b.ts");
    fs.writeFileSync(secondFile, "export const b = true;\n");

    const expander = new ContextExpander(
      root,
      [root, secondRoot],
      [
        { name: "root1", fsPath: root },
        { name: "root2", fsPath: secondRoot },
      ],
      true
    );
    const result = await expander.sanitizeReferences(
      "Have a look at @root2/b.ts, then update the tests."
    );

    assert.strictEqual(
      result,
      `Have a look at @${secondFile}, then update the tests.`
    );
  });
});
