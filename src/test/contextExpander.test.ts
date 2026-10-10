import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { ContextExpander } from "../utils/ContextExpander";
import { getGitUntrackedFiles } from "../utils/GitUtils";
import {
  parseSelectionReferences,
  parseSymbolReferences,
} from "../utils/FileReferenceParser";
import {
  MAX_CONTENT_SIZE,
  MAX_SOURCE_RUNTIME_ARTIFACT_COPY_BYTES,
} from "../types/DashboardConstants";
import { configService } from "../config/CtrlYokeConfigService";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import { makeTempDir, removeTempDir } from "./helpers/tempWorkspace";

suite("ContextExpander.expandContextSplit", () => {
  let workspaceRoot: string;
  const temporaryRoots: string[] = [];

  function freshWorkspace(): string {
    workspaceRoot = makeTempDir("cy-ctx-");
    return workspaceRoot;
  }

  function freshTemporaryRoot(label: string): string {
    const root = makeTempDir(`cy-ctx-${label}-`);
    temporaryRoots.push(root);
    return root;
  }

  function createGitRepository(): string {
    const root = freshTemporaryRoot("source");
    execFileSync("git", ["-C", root, "init", "-q"]);
    fs.writeFileSync(path.join(root, ".gitignore"), "runtime/\n");
    execFileSync("git", ["-C", root, "add", ".gitignore"]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=ctrlyoke-test",
      "-c",
      "user.email=ctrlyoke-test@example.com",
      "commit",
      "-m",
      "initial commit",
    ]);
    return root;
  }

  function writeRepositoryFile(root: string, relativePath: string): string {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${relativePath}\n`);
    return filePath;
  }

  afterEach(() => {
    removeTempDir(workspaceRoot);
    for (const root of temporaryRoots.splice(0)) {
      removeTempDir(root);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("no references", () => {
    test("returns empty result for prompt with no @-references", async () => {
      const root = freshWorkspace();
      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(
        "Just a plain text prompt with no file references."
      );
      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("returns empty result for empty string", async () => {
      const root = freshWorkspace();
      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit("");
      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("full-file @path references", () => {
    test("single-root basename prefix resolves to a same-named subdirectory", async () => {
      const root = freshWorkspace();
      const rootName = path.basename(root);
      const filePath = path.join(root, rootName, "settings.py");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "DEBUG = True\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        namedRoots: [{ name: rootName, fsPath: root }],
      });
      const result = await expander.expandContextSplit(
        `Review @${rootName}/settings.py`
      );

      assert.deepStrictEqual(result.directFileRefs, [filePath]);
      assert.deepStrictEqual(result.skippedReferences, []);
    });

    test("single-root folder-name prefix attaches the root's file when no same-named subdirectory exists", async () => {
      const root = freshWorkspace();
      const rootName = path.basename(root);
      const filePath = path.join(root, "docs", "plan.md");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "# Plan\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        namedRoots: [{ name: rootName, fsPath: root }],
      });
      const result = await expander.expandContextSplit(
        `Review @${rootName}/docs/plan.md`
      );

      assert.deepStrictEqual(result.directFileRefs, [filePath]);
      assert.deepStrictEqual(result.skippedReferences, []);
    });

    test("puts full-file @path ref into directFileRefs as absolute path", async () => {
      const root = freshWorkspace();
      // Create an actual file to reference
      const filePath = path.join(root, "src", "helper.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "export const x = 1;\n");

      const expander = new ContextExpander({ workspaceRoot: root });
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

      const expander = new ContextExpander({ workspaceRoot: root });
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

      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(
        "See @utils.ts and also @utils.ts again."
      );

      assert.strictEqual(result.directFileRefs.length, 1);
      assert.strictEqual(result.directFileRefs[0], filePath);
    });
  });

  suite("source checkout runtime references", () => {
    test("does not invoke Git for a non-worktree expansion", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "ordinary.log");
      fs.writeFileSync(filePath, "ordinary\n");
      const tracePath = path.join(root, "git-trace.jsonl");
      const previousTracePath = process.env.GIT_TRACE2_EVENT;
      process.env.GIT_TRACE2_EVENT = tracePath;
      try {
        const expander = new ContextExpander({ workspaceRoot: root });
        const result = await expander.expandContextSplit(
          "Review @ordinary.log"
        );
        assert.deepStrictEqual(result.directFileRefs, [filePath]);
      } finally {
        if (previousTracePath === undefined) {
          delete process.env.GIT_TRACE2_EVENT;
        } else {
          process.env.GIT_TRACE2_EVENT = previousTracePath;
        }
      }

      const trace = fs.existsSync(tracePath)
        ? fs.readFileSync(tracePath, "utf8")
        : "";
      assert.strictEqual(trace.includes('"name":"check-ignore"'), false);
    });

    test("tier 1 wins when a file exists in both checkouts", async () => {
      const sourceRoot = createGitRepository();
      const executionRoot = freshWorkspace();
      const sourcePath = writeRepositoryFile(sourceRoot, "runtime/shared.log");
      const executionPath = path.join(executionRoot, "runtime", "shared.log");
      fs.mkdirSync(path.dirname(executionPath), { recursive: true });
      fs.writeFileSync(executionPath, "execution copy\n");

      const expander = new ContextExpander({
        workspaceRoot: executionRoot,
        additionalTrustedRoots: [executionRoot],
        sourceCheckoutRoot: sourceRoot,
        executionCheckoutRoot: executionRoot,
      });
      const result = await expander.expandContextSplit(
        "Review @runtime/shared.log"
      );

      assert.deepStrictEqual(result.directFileRefs, [executionPath]);
      assert.ok(!result.directFileRefs.includes(sourcePath));
    });

    test("resolves a gitignored source-only file in relative and absolute forms", async () => {
      const sourceRoot = createGitRepository();
      const executionRoot = freshWorkspace();
      const sourcePath = writeRepositoryFile(sourceRoot, "runtime/source.log");

      const expander = new ContextExpander({
        workspaceRoot: executionRoot,
        additionalTrustedRoots: [executionRoot],
        sourceCheckoutRoot: sourceRoot,
        executionCheckoutRoot: executionRoot,
      });
      const result = await expander.expandContextSplit(
        `Review @runtime/source.log and @"${sourcePath}"`
      );

      const destinationPath = path.join(executionRoot, "runtime", "source.log");
      assert.deepStrictEqual(result.directFileRefs, [destinationPath]);
      assert.deepStrictEqual(result.sourceRuntimeCopies, [
        { reference: "@runtime/source.log", sourcePath, destinationPath },
      ]);
    });

    test("leaves a copied ref's inline token workspace-relative and unrewritten", async () => {
      const sourceRoot = createGitRepository();
      const executionRoot = freshWorkspace();
      writeRepositoryFile(sourceRoot, "runtime/source.log");

      const expander = new ContextExpander({
        workspaceRoot: executionRoot,
        additionalTrustedRoots: [executionRoot],
        sourceCheckoutRoot: sourceRoot,
        executionCheckoutRoot: executionRoot,
        effectiveAbsolute: true,
      });

      assert.strictEqual(
        await expander.sanitizeReferences("Review @runtime/source.log"),
        "Review @runtime/source.log"
      );
    });

    test("copies a multi-megabyte source log above MAX_CONTENT_SIZE under the copy ceiling", async () => {
      const sourceRoot = createGitRepository();
      const executionRoot = freshWorkspace();
      const sourcePath = path.join(sourceRoot, "runtime", "large.log");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, Buffer.alloc(MAX_CONTENT_SIZE + 1024, 65));

      const expander = new ContextExpander({
        workspaceRoot: executionRoot,
        additionalTrustedRoots: [executionRoot],
        sourceCheckoutRoot: sourceRoot,
        executionCheckoutRoot: executionRoot,
      });
      const result = await expander.expandContextSplit(
        "Review @runtime/large.log"
      );

      assert.ok(sourcePath.length > 0);
      assert.strictEqual(result.sourceRuntimeCopies.length, 1);
      assert.strictEqual(result.skippedReferences.length, 0);
      assert.strictEqual(
        result.directFileRefs[0],
        path.join(executionRoot, "runtime", "large.log")
      );
    });

    test("keeps copied runtime files out of getGitUntrackedFiles", async () => {
      const sourceRoot = createGitRepository();
      const executionRoot = createGitRepository();
      const sourcePath = writeRepositoryFile(sourceRoot, "runtime/session.log");
      const destinationPath = path.join(
        executionRoot,
        "runtime",
        "session.log"
      );
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);

      const untrackedFiles = await getGitUntrackedFiles(executionRoot);
      assert.ok(!untrackedFiles.includes("runtime/session.log"));
    });

    test("refuses a source artifact over the copy ceiling by name and size", async () => {
      const sourceRoot = createGitRepository();
      const executionRoot = freshWorkspace();
      const sourcePath = path.join(sourceRoot, "runtime", "too-large.log");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, "x");
      fs.truncateSync(sourcePath, MAX_SOURCE_RUNTIME_ARTIFACT_COPY_BYTES + 1);

      const expander = new ContextExpander({
        workspaceRoot: executionRoot,
        additionalTrustedRoots: [executionRoot],
        sourceCheckoutRoot: sourceRoot,
        executionCheckoutRoot: executionRoot,
      });
      const result = await expander.expandContextSplit(
        "Review @runtime/too-large.log"
      );

      assert.deepStrictEqual(result.sourceRuntimeCopies, []);
      const skipped = result.skippedReferences.find(
        (ref) => ref.ref === "runtime/too-large.log"
      );
      assert.ok(skipped);
      assert.ok(
        skipped.reason.includes("MAX_SOURCE_RUNTIME_ARTIFACT_COPY_BYTES")
      );
      assert.ok(
        skipped.reason.includes(`${MAX_SOURCE_RUNTIME_ARTIFACT_COPY_BYTES + 1}`)
      );
    });

    test("renders the same absolute source path in excerpts and sanitized references", async () => {
      const sourceRoot = createGitRepository();
      const executionRoot = freshWorkspace();
      const sourcePath = writeRepositoryFile(sourceRoot, "runtime/source.log");
      const reference = "#selection:runtime/source.log:1-1";

      const expander = new ContextExpander({
        workspaceRoot: executionRoot,
        additionalTrustedRoots: [executionRoot],
        sourceCheckoutRoot: sourceRoot,
        executionCheckoutRoot: executionRoot,
      });
      const expanded = await expander.expandContextSplit(reference);
      const sanitized = await expander.sanitizeReferences(reference);

      assert.ok(
        expanded.excerptBlocks.includes(
          `Excerpt from ${sourcePath}, lines 1 to 1`
        )
      );
      assert.strictEqual(sanitized, `#selection:"${sourcePath}":1-1`);
      assert.ok(
        expanded.excerptBlocks.includes(sourcePath),
        "the excerpt must name the same absolute source path as sanitizeReferences"
      );
      assert.ok(
        sanitized.includes(sourcePath),
        "sanitizeReferences must name the same absolute source path as the excerpt"
      );
      assert.deepStrictEqual(expanded.sourceRuntimeReadReferences, [reference]);
    });

    test("blocks a source-only ignored directory and reports its token", async () => {
      const sourceRoot = createGitRepository();
      const executionRoot = freshWorkspace();
      const sourceDirectory = path.join(sourceRoot, "runtime");
      fs.mkdirSync(sourceDirectory, { recursive: true });
      fs.writeFileSync(path.join(sourceDirectory, "source.log"), "source\n");

      const expander = new ContextExpander({
        workspaceRoot: executionRoot,
        additionalTrustedRoots: [executionRoot],
        sourceCheckoutRoot: sourceRoot,
        executionCheckoutRoot: executionRoot,
      });
      const result = await expander.expandContextSplit(
        "Review @runtime/ before continuing."
      );

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
      assert.ok(
        result.skippedReferences.some(
          (ref) =>
            ref.ref === "runtime/" &&
            ref.reason.includes("@runtime/") &&
            ref.reason.includes("blocked")
        )
      );
    });

    test("keeps a tracked-but-absent source file unresolved", async () => {
      const sourceRoot = createGitRepository();
      const executionRoot = freshWorkspace();
      const sourcePath = writeRepositoryFile(sourceRoot, "tracked.log");
      execFileSync("git", ["-C", sourceRoot, "add", "tracked.log"]);
      execFileSync("git", [
        "-C",
        sourceRoot,
        "-c",
        "user.name=ctrlyoke-test",
        "-c",
        "user.email=ctrlyoke-test@example.com",
        "commit",
        "-m",
        "add tracked file",
      ]);

      const expander = new ContextExpander({
        workspaceRoot: executionRoot,
        additionalTrustedRoots: [executionRoot],
        sourceCheckoutRoot: sourceRoot,
        executionCheckoutRoot: executionRoot,
      });
      const result = await expander.expandContextSplit("Review @tracked.log");

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.ok(
        result.skippedReferences.some((ref) => ref.ref === "tracked.log")
      );
      assert.ok(fs.existsSync(sourcePath));
    });

    test("keeps an ignored file outside the source checkout blocked", async () => {
      const sourceRoot = createGitRepository();
      const executionRoot = freshWorkspace();
      const outsideRoot = freshTemporaryRoot("outside");
      const outsidePath = writeRepositoryFile(
        outsideRoot,
        "runtime/outside.log"
      );

      const expander = new ContextExpander({
        workspaceRoot: executionRoot,
        additionalTrustedRoots: [executionRoot],
        sourceCheckoutRoot: sourceRoot,
        executionCheckoutRoot: executionRoot,
      });
      const result = await expander.expandContextSplit(
        `Review @"${outsidePath}"`
      );

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.ok(
        result.skippedReferences.some((ref) =>
          ref.reason.includes("resolves outside the workspace and was blocked")
        )
      );
    });

    test("does not spawn check-ignore for a non-worktree expansion", async () => {
      const root = freshWorkspace();
      const filePath = writeRepositoryFile(root, "runtime/plain.log");
      const tracePath = path.join(freshTemporaryRoot("trace"), "git.jsonl");
      const previousTracePath = process.env.GIT_TRACE2_EVENT;
      process.env.GIT_TRACE2_EVENT = tracePath;
      try {
        const expander = new ContextExpander({ workspaceRoot: root });
        const result = await expander.expandContextSplit(
          "Review @runtime/plain.log"
        );
        assert.deepStrictEqual(result.directFileRefs, [filePath]);
      } finally {
        if (previousTracePath === undefined) {
          delete process.env.GIT_TRACE2_EVENT;
        } else {
          process.env.GIT_TRACE2_EVENT = previousTracePath;
        }
      }
      assert.strictEqual(fs.existsSync(tracePath), false);
    });

    test("runs one check-ignore subprocess for many references", async () => {
      const sourceRoot = createGitRepository();
      const executionRoot = freshWorkspace();
      const paths = [0, 1, 2].map((index) =>
        writeRepositoryFile(sourceRoot, `runtime/log-${index}.log`)
      );
      const tracePath = path.join(freshTemporaryRoot("trace"), "git.jsonl");
      const previousTracePath = process.env.GIT_TRACE2_EVENT;
      process.env.GIT_TRACE2_EVENT = tracePath;
      try {
        const expander = new ContextExpander({
          workspaceRoot: executionRoot,
          additionalTrustedRoots: [executionRoot],
          sourceCheckoutRoot: sourceRoot,
          executionCheckoutRoot: executionRoot,
        });
        const result = await expander.expandContextSplit(
          paths.map((_, index) => `@runtime/log-${index}.log`).join(" ")
        );
        assert.deepStrictEqual(
          result.directFileRefs,
          paths.map((sourcePath) =>
            path.join(executionRoot, path.relative(sourceRoot, sourcePath))
          )
        );
        assert.strictEqual(result.sourceRuntimeCopies.length, paths.length);
      } finally {
        if (previousTracePath === undefined) {
          delete process.env.GIT_TRACE2_EVENT;
        } else {
          process.env.GIT_TRACE2_EVENT = previousTracePath;
        }
      }

      const checkIgnoreCommands = fs
        .readFileSync(tracePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: string; name?: string })
        .filter(
          (event) => event.event === "cmd_name" && event.name === "check-ignore"
        );
      assert.strictEqual(checkIgnoreCommands.length, 1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("git change references", () => {
    test("reports a missing commit hash in skippedReferences", async () => {
      const root = createGitRepository();
      const missingHash = "0123456789abcdef0123456789abcdef01234567";
      const rawReference = `~${missingHash}`;

      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(
        `Review ${rawReference}`
      );

      assert.strictEqual(result.excerptBlocks, "");
      const skipped = result.skippedReferences.find(
        (reference) => reference.ref === rawReference
      );
      assert.ok(skipped);
      assert.ok(skipped.reason.length > 0);
    });

    test("does not report a successful commit hash as skipped", async () => {
      const root = createGitRepository();
      const hash = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();

      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(`Review ~${hash}`);

      assert.ok(
        result.excerptBlocks.includes(`<attachment id="git:commit:${hash}">`)
      );
      assert.deepStrictEqual(result.skippedReferences, []);
    });

    test("does not report a duplicate commit hash as skipped", async () => {
      const root = createGitRepository();
      const hash = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();

      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(
        `Review ~${hash} and then review ~${hash} again.`
      );

      const attachmentId = `<attachment id="git:commit:${hash}">`;
      assert.strictEqual(
        result.excerptBlocks.split(attachmentId).length - 1,
        1
      );
      assert.deepStrictEqual(result.skippedReferences, []);
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

      const expander = new ContextExpander({ workspaceRoot: root });
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

      const expander = new ContextExpander({ workspaceRoot: root });
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

      const expander = new ContextExpander({ workspaceRoot: root });
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

    test("skips line zero, reversed, and past-the-end ranges", async () => {
      const root = freshWorkspace();
      fs.writeFileSync(path.join(root, "range.ts"), "one\ntwo\nthree\nfour");

      for (const reference of [
        "#selection:range.ts:0-2",
        "#selection:range.ts:4-2",
        "#selection:range.ts:5-6",
        "#sym:range.ts:item:0-2",
        "#sym:range.ts:item:4-2",
        "#sym:range.ts:item:5-6",
      ]) {
        const result = await new ContextExpander({
          workspaceRoot: root,
        }).expandContextSplit(reference);

        assert.deepStrictEqual(result.directFileRefs, [], reference);
        assert.strictEqual(result.excerptBlocks, "", reference);
        assert.strictEqual(result.skippedReferences.length, 1, reference);
        assert.match(
          result.skippedReferences[0].reason,
          /Invalid line range/,
          reference
        );
      }
    });

    test("valid ranges still attach exactly the requested lines", async () => {
      const root = freshWorkspace();
      fs.writeFileSync(path.join(root, "range.ts"), "one\ntwo\nthree\nfour");

      for (const reference of [
        "#selection:range.ts:2-3",
        "#sym:range.ts:item:2-3",
      ]) {
        const result = await new ContextExpander({
          workspaceRoot: root,
        }).expandContextSplit(reference);

        assert.strictEqual(result.skippedReferences.length, 0, reference);
        assert.ok(result.excerptBlocks.includes("    2→two"), reference);
        assert.ok(result.excerptBlocks.includes("    3→three"), reference);
        assert.ok(!result.excerptBlocks.includes("    1→one"), reference);
        assert.ok(!result.excerptBlocks.includes("    4→four"), reference);
      }
    });

    test("excerpt does not include line 1 reference when range starts at line 5", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "offset.ts");
      const lines = Array.from({ length: 8 }, (_, i) => `content${i + 1}`);
      fs.writeFileSync(filePath, lines.join("\n"));

      const expander = new ContextExpander({ workspaceRoot: root });
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

      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(
        "Check #sym:symbol.ts:notARealSymbol:2-4"
      );

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.ok(result.excerptBlocks.includes("    2→start"));
      assert.ok(result.excerptBlocks.includes("    4→end"));
      assert.ok(!result.excerptBlocks.includes("    5→after"));
    });

    test("attaches identical content for kinded and unkinded symbols", async () => {
      const root = freshWorkspace();
      fs.writeFileSync(
        path.join(root, "symbol.ts"),
        ["before", "start", "end"].join("\n")
      );

      const unkinded = await new ContextExpander({
        workspaceRoot: root,
      }).expandContextSplit("#sym:symbol.ts:notARealSymbol:2-3");
      const kinded = await new ContextExpander({
        workspaceRoot: root,
      }).expandContextSplit("#sym.class:symbol.ts:notARealSymbol:2-3");

      assert.deepStrictEqual(kinded, unkinded);
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

      const expander = new ContextExpander({ workspaceRoot: root });
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

  suite("git commit references", () => {
    test("uses the commit subject as the attachment title", async () => {
      const root = createGitRepository();
      writeRepositoryFile(root, "subject.txt");
      execFileSync("git", ["-C", root, "add", "subject.txt"]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=ctrlyoke-test",
        "-c",
        "user.email=ctrlyoke-test@example.com",
        "commit",
        "-m",
        "Subject for attachment title",
      ]);
      const hash = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();

      const result = await new ContextExpander({
        workspaceRoot: root,
      }).expandContextSplit(`~${hash}`);

      assert.ok(
        result.excerptBlocks.includes(
          `Commit ${hash.slice(0, 7)}: Subject for attachment title`
        ),
        result.excerptBlocks
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("triple-backtick fenced block suppression", () => {
    test("does not expand @, #selection, #sym, or ~ refs inside fenced blocks", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "inside.ts");
      fs.writeFileSync(filePath, "export function inside() {}\n");

      const expander = new ContextExpander({ workspaceRoot: root });
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

      const expander = new ContextExpander({ workspaceRoot: root });
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

      const expander = new ContextExpander({ workspaceRoot: root });
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

      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(
        ["Here is an unclosed fence:", "```ts", "@unclosed.ts"].join("\n")
      );

      assert.deepStrictEqual(result.directFileRefs, [filePath]);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("suppresses references inside single-backtick inline code", async () => {
      const root = freshWorkspace();
      const inlinePath = path.join(root, "inline.ts");
      const livePath = path.join(root, "live.ts");
      fs.writeFileSync(inlinePath, "export const inline = true;\n");
      fs.writeFileSync(livePath, "export const live = true;\n");

      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(
        "Check `@inline.ts` while reviewing @live.ts."
      );

      assert.deepStrictEqual(result.directFileRefs, [livePath]);
      assert.strictEqual(result.excerptBlocks, "");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("path traversal protection", () => {
    let outsideDir: string;

    afterEach(() => {
      removeTempDir(outsideDir);
    });

    test("blocks a full-file @path ref that escapes the workspace via '..'", async () => {
      const root = freshWorkspace();
      outsideDir = makeTempDir("cy-ctx-outside-");
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "TOP SECRET\n");
      const traversal = path.relative(
        root,
        path.join(outsideDir, "secret.txt")
      );

      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(`@${traversal}`);

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("blocks an absolute-path @path ref outside the workspace", async () => {
      const root = freshWorkspace();
      outsideDir = makeTempDir("cy-ctx-outside-");
      const absPath = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(absPath, "TOP SECRET\n");

      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(`@${absPath}`);

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("blocks a #selection: range ref that escapes the workspace via '..'", async () => {
      const root = freshWorkspace();
      outsideDir = makeTempDir("cy-ctx-outside-");
      fs.writeFileSync(
        path.join(outsideDir, "secret.txt"),
        "TOP\nSECRET\nDATA\n"
      );
      const traversal = path.relative(
        root,
        path.join(outsideDir, "secret.txt")
      );

      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(
        `#selection:${traversal}:1-2`
      );

      assert.strictEqual(result.excerptBlocks, "");
      assert.ok(!result.excerptBlocks.includes("TOP"));
    });

    test("still allows a legitimate in-workspace reference alongside a blocked one", async () => {
      const root = freshWorkspace();
      outsideDir = makeTempDir("cy-ctx-outside-");
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "TOP SECRET\n");
      const traversal = path.relative(
        root,
        path.join(outsideDir, "secret.txt")
      );
      const insideFile = path.join(root, "inside.ts");
      fs.writeFileSync(insideFile, "export const inside = true;\n");

      const expander = new ContextExpander({ workspaceRoot: root });
      const result = await expander.expandContextSplit(
        `@${traversal} and @inside.ts`
      );

      assert.deepStrictEqual(result.directFileRefs, [insideFile]);
    });

    test("resolves ./ refs from the workflow directory and bare refs from the workspace root", async () => {
      const root = freshWorkspace();
      const workflowDir = path.join(root, "workflows");
      fs.mkdirSync(workflowDir);
      const workflowFile = path.join(workflowDir, "asset.txt");
      const workspaceFile = path.join(root, "asset.txt");
      fs.writeFileSync(workflowFile, "workflow asset\n");
      fs.writeFileSync(workspaceFile, "workspace asset\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root],
        effectiveAbsolute: false,
        sourceDefinitionDir: workflowDir,
      });
      const result = await expander.expandContextSplit(
        "@./asset.txt and @asset.txt"
      );

      assert.deepStrictEqual(result.directFileRefs, [
        workflowFile,
        workspaceFile,
      ]);
    });

    test("resolves a workflow-relative traversal before blocking it outside trusted roots", async () => {
      const root = freshWorkspace();
      const workflowDir = path.join(root, "workflows", "deep");
      fs.mkdirSync(workflowDir, { recursive: true });

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root],
        effectiveAbsolute: false,
        sourceDefinitionDir: workflowDir,
      });
      const result = await expander.expandContextSplit(
        "@./../../../outside.txt"
      );

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("treats workflow-relative refs without a source directory as unresolvable", async () => {
      const root = freshWorkspace();
      fs.writeFileSync(path.join(root, "asset.txt"), "workspace asset\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root],
      });
      const result = await expander.expandContextSplit("@./asset.txt");

      assert.deepStrictEqual(result.directFileRefs, []);
      assert.strictEqual(result.excerptBlocks, "");
    });

    test("deduplicates references naming one file through workspace and workflow-relative forms", async () => {
      const root = freshWorkspace();
      const workflowDir = path.join(root, "workflows");
      fs.mkdirSync(workflowDir);
      const filePath = path.join(root, "shared.txt");
      fs.writeFileSync(filePath, "shared\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root],
        effectiveAbsolute: false,
        sourceDefinitionDir: workflowDir,
      });
      const result = await expander.expandContextSplit(
        "@shared.txt and @./../shared.txt"
      );

      assert.deepStrictEqual(result.directFileRefs, [filePath]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("multi-root workspace trust", () => {
    let secondRoot: string;

    afterEach(() => {
      removeTempDir(secondRoot);
    });

    test("allows a full-file ref into a second trusted root that is not a descendant of the primary root", async () => {
      const root = freshWorkspace();
      secondRoot = makeTempDir("cy-ctx-second-");
      const secondFile = path.join(secondRoot, "b.ts");
      fs.writeFileSync(secondFile, "export const b = true;\n");
      const relativeFromPrimary = path.relative(root, secondFile);

      // Without the second root registered as trusted, the same reference
      // must be rejected (this is the regression the multi-root fix closes).
      const untrustedExpander = new ContextExpander({ workspaceRoot: root });
      const untrustedResult = await untrustedExpander.expandContextSplit(
        `@${relativeFromPrimary}`
      );
      assert.deepStrictEqual(untrustedResult.directFileRefs, []);

      const trustedExpander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root, secondRoot],
        effectiveAbsolute: false,
        sourceDefinitionDir: root,
      });
      const trustedResult = await trustedExpander.expandContextSplit(
        `@${relativeFromPrimary}`
      );
      assert.deepStrictEqual(trustedResult.directFileRefs, [secondFile]);
    });

    test("allows a @dir/ reference into a second trusted root", async () => {
      const root = freshWorkspace();
      secondRoot = makeTempDir("cy-ctx-second-");
      fs.mkdirSync(path.join(secondRoot, "sub"));
      fs.writeFileSync(path.join(secondRoot, "sub", "c.ts"), "// c\n");
      const relativeDir = path.relative(root, path.join(secondRoot, "sub"));

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root, secondRoot],
        effectiveAbsolute: false,
        sourceDefinitionDir: root,
      });
      const result = await expander.expandContextSplit(`@${relativeDir}/`);

      assert.ok(result.excerptBlocks.includes("c.ts"));
      assert.ok(!result.excerptBlocks.includes("blocked"));
    });

    test("still blocks a reference outside every trusted root", async () => {
      const root = freshWorkspace();
      secondRoot = makeTempDir("cy-ctx-second-");
      const untrustedDir = makeTempDir("cy-ctx-untrusted-");
      fs.writeFileSync(path.join(untrustedDir, "secret.txt"), "TOP SECRET\n");
      const traversal = path.relative(
        root,
        path.join(untrustedDir, "secret.txt")
      );

      try {
        const expander = new ContextExpander({
          workspaceRoot: root,
          additionalTrustedRoots: [root, secondRoot],
          effectiveAbsolute: false,
          sourceDefinitionDir: root,
        });
        const result = await expander.expandContextSplit(`@${traversal}`);

        assert.deepStrictEqual(result.directFileRefs, []);
      } finally {
        removeTempDir(untrustedDir);
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
      removeTempDir(externalRoot);
    });

    test("attaches a trusted external full-file reference", async () => {
      const root = freshWorkspace();
      externalRoot = makeTempDir("cy-ctx-ext-");
      const externalFile = path.join(externalRoot, "session.jsonl");
      fs.writeFileSync(externalFile, '{"event":"start"}\n');

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root, externalRoot],
      });
      const result = await expander.expandContextSplit(`@"${externalFile}"`);

      assert.deepStrictEqual(result.directFileRefs, [externalFile]);
    });

    test("attaches a trusted external selection excerpt", async () => {
      const root = freshWorkspace();
      externalRoot = makeTempDir("cy-ctx-ext-");
      const externalFile = path.join(externalRoot, "debug.log");
      fs.writeFileSync(externalFile, "line1\nline2\nline3\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root, externalRoot],
      });
      const result = await expander.expandContextSplit(
        `#selection:"${externalFile}":1-2`
      );

      assert.ok(result.excerptBlocks.includes("line1"));
      assert.ok(result.excerptBlocks.includes("line2"));
    });

    test("attaches a trusted external directory listing", async () => {
      const root = freshWorkspace();
      externalRoot = makeTempDir("cy-ctx-ext-");
      fs.writeFileSync(path.join(externalRoot, "notes.txt"), "hi\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root, externalRoot],
      });
      const result = await expander.expandContextSplit(`@"${externalRoot}/"`);

      assert.ok(result.excerptBlocks.includes("notes.txt"));
      assert.ok(!result.excerptBlocks.includes("blocked"));
    });

    test("blocks an unapproved external full-file reference", async () => {
      const root = freshWorkspace();
      externalRoot = makeTempDir("cy-ctx-ext-");
      const externalFile = path.join(externalRoot, "session.jsonl");
      fs.writeFileSync(externalFile, '{"event":"start"}\n');

      // externalRoot intentionally NOT included in additionalTrustedRoots —
      // simulates a root that is configured but not yet approved.
      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root],
      });
      const result = await expander.expandContextSplit(`@"${externalFile}"`);

      assert.deepStrictEqual(result.directFileRefs, []);
    });

    test("blocks an unapproved external directory listing", async () => {
      const root = freshWorkspace();
      externalRoot = makeTempDir("cy-ctx-ext-");
      fs.writeFileSync(path.join(externalRoot, "notes.txt"), "hi\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root],
      });
      const result = await expander.expandContextSplit(`@"${externalRoot}/"`);

      assert.ok(result.excerptBlocks.includes("blocked"));
    });

    test("uses only the approved roots declared by the current workflow", async () => {
      const root = freshWorkspace();
      externalRoot = freshTemporaryRoot("workflow");
      const externalFile = path.join(externalRoot, "workflow.txt");
      fs.writeFileSync(externalFile, "workflow-only\n");
      const workflowFile = path.join(root, "workflow.ctrlyoke.json");
      const workspaceIdentity = ExternalRootsTrustStore.canonicalizeRoot(root);
      const workflowIdentity =
        ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
          root,
          workflowFile
        );
      const deniedWorkflowIdentity =
        ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
          root,
          path.join(root, "denied.ctrlyoke.json")
        );
      const pendingWorkflowIdentity =
        ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
          root,
          path.join(root, "pending.ctrlyoke.json")
        );
      const canonicalExternalRoot =
        ExternalRootsTrustStore.canonicalizeRoot(externalRoot);
      const decisions: Record<string, "allow" | "deny"> = {
        [`${workflowIdentity}::${canonicalExternalRoot}`]: "allow",
        [`${deniedWorkflowIdentity}::${canonicalExternalRoot}`]: "deny",
      };
      const fakeTrustStore = {
        getApprovedRoots: (scopeIdentity: string, roots: readonly string[]) =>
          roots.filter(
            (candidate) =>
              decisions[
                `${scopeIdentity}::${ExternalRootsTrustStore.canonicalizeRoot(candidate)}`
              ] === "allow"
          ),
        getPendingRoots: (scopeIdentity: string, roots: readonly string[]) =>
          roots.filter(
            (candidate) =>
              decisions[
                `${scopeIdentity}::${ExternalRootsTrustStore.canonicalizeRoot(candidate)}`
              ] === undefined
          ),
      };
      configService.setUserBackend({
        getAll: () => ({
          permissions: {
            trustedExternalRoots: [freshTemporaryRoot("inherited")],
          },
        }),
        set: async () => ({}),
      });
      configService.setWorkspaceBackend({
        getAll: () => ({}),
        set: async () => ({}),
      });

      try {
        const approvedRoots =
          ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
            workspaceIdentity,
            {
              identity: workflowIdentity,
              declaredRoots: [externalRoot],
            },
            fakeTrustStore
          );
        const approvedExpander = new ContextExpander({
          workspaceRoot: root,
          additionalTrustedRoots: approvedRoots,
        });
        const approved = await approvedExpander.expandContextSplit(
          `@"${externalFile}"`
        );
        assert.deepStrictEqual(approved.directFileRefs, [externalFile]);

        for (const identity of [
          deniedWorkflowIdentity,
          pendingWorkflowIdentity,
        ]) {
          const blockedRoots =
            ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
              workspaceIdentity,
              { identity, declaredRoots: [externalRoot] },
              fakeTrustStore
            );
          const blockedExpander = new ContextExpander({
            workspaceRoot: root,
            additionalTrustedRoots: blockedRoots,
          });
          const blocked = await blockedExpander.expandContextSplit(
            `@"${externalFile}"`
          );
          assert.deepStrictEqual(blocked.directFileRefs, []);
        }
      } finally {
        configService.setUserBackend({
          getAll: () => ({}),
          set: async () => ({}),
        });
        configService.setWorkspaceBackend({
          getAll: () => ({}),
          set: async () => ({}),
        });
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("named-root (folder-name-prefixed) resolution", () => {
    let secondRoot: string;

    afterEach(() => {
      removeTempDir(secondRoot);
    });

    test("resolves a folder-name-prefixed ref against the matching named root", async () => {
      const root = freshWorkspace();
      secondRoot = makeTempDir("cy-ctx-second-");
      const secondFile = path.join(secondRoot, "b.ts");
      fs.writeFileSync(secondFile, "export const b = true;\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root, secondRoot],
        namedRoots: [
          { name: "root1", fsPath: root },
          { name: "root2", fsPath: secondRoot },
        ],
      });
      const result = await expander.expandContextSplit("@root2/b.ts");

      assert.deepStrictEqual(result.directFileRefs, [secondFile]);
    });

    test("unprefixed ref still resolves against the primary root", async () => {
      const root = freshWorkspace();
      secondRoot = makeTempDir("cy-ctx-second-");
      const primaryFile = path.join(root, "a.ts");
      fs.writeFileSync(primaryFile, "export const a = true;\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root, secondRoot],
        namedRoots: [
          { name: "root1", fsPath: root },
          { name: "root2", fsPath: secondRoot },
        ],
      });
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

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root],
        effectiveAbsolute: false,
      });
      const result = await expander.expandContextSplit("#selection:a.ts:1-2");

      assert.ok(result.excerptBlocks.includes("Excerpt from a.ts"));
      assert.ok(!result.excerptBlocks.includes(filePath));
    });

    test("renders the resolved absolute path in the excerpt when effectiveAbsolute is true", async () => {
      const root = freshWorkspace();
      const filePath = path.join(root, "a.ts");
      fs.writeFileSync(filePath, "line1\nline2\nline3\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root],
        effectiveAbsolute: true,
      });
      const result = await expander.expandContextSplit("#selection:a.ts:1-2");

      assert.ok(result.excerptBlocks.includes(`Excerpt from ${filePath}`));
      // Attachment id stays as-typed (relative) even when rendering absolute.
      assert.ok(result.excerptBlocks.includes('id="selection:a.ts:1-2"'));
    });

    test("renders the resolved absolute directory path in the body when effectiveAbsolute is true", async () => {
      const root = freshWorkspace();
      fs.mkdirSync(path.join(root, "sub"));
      fs.writeFileSync(path.join(root, "sub", "c.ts"), "// c\n");

      const expander = new ContextExpander({
        workspaceRoot: root,
        additionalTrustedRoots: [root],
        effectiveAbsolute: true,
      });
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
    workspaceRoot = makeTempDir("cy-ctx-");
    return workspaceRoot;
  }

  afterEach(() => {
    removeTempDir(workspaceRoot);
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

    const expander = new ContextExpander({ workspaceRoot: root });
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
    workspaceRoot = makeTempDir("cy-ctx-");
    return workspaceRoot;
  }

  afterEach(() => {
    removeTempDir(workspaceRoot);
    removeTempDir(secondRoot);
  });

  test("leaves text untouched when there are no references", async () => {
    const root = freshWorkspace();
    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root],
      effectiveAbsolute: true,
    });
    const text = "Please implement the feature described above.";

    assert.strictEqual(await expander.sanitizeReferences(text), text);
  });

  test("single-root, effectiveAbsolute false: leaves an unprefixed @ref textually unchanged", async () => {
    const root = freshWorkspace();
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root],
      effectiveAbsolute: false,
    });
    const result = await expander.sanitizeReferences(
      "Please review @a.ts for issues."
    );

    assert.strictEqual(result, "Please review @a.ts for issues.");
  });

  test("single-root, effectiveAbsolute false: rewrites workflow-relative @ and excerpt refs to absolute paths", async () => {
    const root = freshWorkspace();
    const workflowDir = path.join(root, "workflows");
    fs.mkdirSync(workflowDir);
    const filePath = path.join(workflowDir, "asset.ts");
    fs.writeFileSync(filePath, "export const asset = true;\n");

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root],
      effectiveAbsolute: false,
      sourceDefinitionDir: workflowDir,
    });
    const references = [
      "@./asset.ts",
      "#selection:./asset.ts:1-1",
      "#sym:./asset.ts:asset:1-1",
    ];

    for (const reference of references) {
      const result = await expander.sanitizeReferences(reference);
      assert.ok(!result.includes("./"), `rewrote ${reference}: ${result}`);
      assert.ok(result.includes(filePath), `rewrote ${reference}: ${result}`);
    }
  });

  test("multi-root, effectiveAbsolute true: rewrites a folder-prefixed @ref to its absolute path", async () => {
    const root = freshWorkspace();
    secondRoot = makeTempDir("cy-ctx-second-");
    const secondFile = path.join(secondRoot, "b.ts");
    fs.writeFileSync(secondFile, "export const b = true;\n");

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root, secondRoot],
      namedRoots: [
        { name: "root1", fsPath: root },
        { name: "root2", fsPath: secondRoot },
      ],
      effectiveAbsolute: true,
    });
    const result = await expander.sanitizeReferences(
      "Please fix @root2/b.ts before merging."
    );

    assert.strictEqual(result, `Please fix @${secondFile} before merging.`);
  });

  test("multi-root, effectiveAbsolute true: rewrites a folder-prefixed #sym: ref to its absolute path", async () => {
    const root = freshWorkspace();
    secondRoot = makeTempDir("cy-ctx-second-");
    const secondFile = path.join(secondRoot, "b.ts");
    fs.writeFileSync(secondFile, "export function foo() {}\n");

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root, secondRoot],
      namedRoots: [
        { name: "root1", fsPath: root },
        { name: "root2", fsPath: secondRoot },
      ],
      effectiveAbsolute: true,
    });
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

  test("preserves the embedded kind when rewriting a multi-root #sym: ref", async () => {
    const root = freshWorkspace();
    secondRoot = makeTempDir("cy-ctx-second-");
    const secondFile = path.join(secondRoot, "b.ts");
    fs.writeFileSync(secondFile, "export class Foo {}\n");

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root, secondRoot],
      namedRoots: [
        { name: "root1", fsPath: root },
        { name: "root2", fsPath: secondRoot },
      ],
      effectiveAbsolute: true,
    });
    const result = await expander.sanitizeReferences(
      "When #sym.class:root2/b.ts:Foo:1-1 runs, log the result."
    );

    assert.strictEqual(
      result,
      `When #sym.class:"${secondFile}":Foo:1-1 runs, log the result.`
    );
    assert.deepStrictEqual(
      parseSymbolReferences(result).map((ref) => [
        ref.path,
        ref.symbolName,
        ref.symbolKind,
      ]),
      [[secondFile, "Foo", "class"]],
      "rewritten #sym.class: token must round-trip with its kind"
    );
  });

  test("rewrites a source-store #sym: ref while preserving kind, symbol, and range", async () => {
    secondRoot = makeTempDir("cy-ctx-source-");
    const sourceRoot = secondRoot;
    const executionRoot = freshWorkspace();
    fs.mkdirSync(path.join(sourceRoot, "runtime"), { recursive: true });
    const sourcePath = path.join(sourceRoot, "runtime", "source.ts");
    fs.writeFileSync(sourcePath, "export class Foo {}\n");
    fs.writeFileSync(path.join(sourceRoot, ".gitignore"), "runtime/\n");
    execFileSync("git", ["-C", sourceRoot, "init", "-q"]);
    execFileSync("git", ["-C", sourceRoot, "add", ".gitignore"]);
    execFileSync("git", [
      "-C",
      sourceRoot,
      "-c",
      "user.name=ctrlyoke-test",
      "-c",
      "user.email=ctrlyoke-test@example.com",
      "commit",
      "-m",
      "initial commit",
    ]);

    const expander = new ContextExpander({
      workspaceRoot: executionRoot,
      additionalTrustedRoots: [executionRoot],
      sourceCheckoutRoot: sourceRoot,
      executionCheckoutRoot: executionRoot,
    });
    const result = await expander.sanitizeReferences(
      "Review #sym.class:runtime/source.ts:Foo:1-1."
    );

    assert.strictEqual(result, `Review #sym.class:"${sourcePath}":Foo:1-1.`);
    assert.deepStrictEqual(
      parseSymbolReferences(result).map((ref) => [
        ref.path,
        ref.symbolKind,
        ref.symbolName,
        ref.startLine,
        ref.endLine,
      ]),
      [[sourcePath, "class", "Foo", 1, 1]]
    );
  });

  test("multi-root, effectiveAbsolute true: rewrites a folder-prefixed #selection: ref to its absolute path", async () => {
    const root = freshWorkspace();
    secondRoot = makeTempDir("cy-ctx-second-");
    const secondFile = path.join(secondRoot, "b.ts");
    fs.writeFileSync(secondFile, "line1\nline2\n");

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root, secondRoot],
      namedRoots: [
        { name: "root1", fsPath: root },
        { name: "root2", fsPath: secondRoot },
      ],
      effectiveAbsolute: true,
    });
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

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root],
      effectiveAbsolute: false,
    });
    const text = "See #selection:a.ts:1-2 and #sym:a.ts:foo:1-2 here.";

    assert.strictEqual(await expander.sanitizeReferences(text), text);
  });

  test("never rewrites #selection or #sym ranges into full-file @ refs", async () => {
    const root = freshWorkspace();
    fs.writeFileSync(path.join(root, "a.ts"), "line1\nline2\n");

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root],
      effectiveAbsolute: true,
    });
    const text = "#selection:a.ts:0-2 and #sym:a.ts:foo:0-1";
    const result = await expander.sanitizeReferences(text);

    assert.ok(result.includes("#selection:"));
    assert.ok(result.includes("#sym:"));
    assert.ok(!result.includes("@a.ts"));
    assert.strictEqual(parseSelectionReferences(result).length, 1);
    assert.strictEqual(parseSymbolReferences(result).length, 1);
  });

  test("applies a custom formatFileRef (e.g. Codex dropping the @) even in single-root", async () => {
    const root = freshWorkspace();
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root],
      effectiveAbsolute: false,
    });
    const result = await expander.sanitizeReferences(
      "Please review @a.ts for issues.",
      (quotedPath) => quotedPath
    );

    assert.strictEqual(result, "Please review a.ts for issues.");
  });

  test("leaves an unreadable/nonexistent reference untouched", async () => {
    const root = freshWorkspace();
    const text = "See @missing.ts for details.";

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root],
      effectiveAbsolute: true,
    });
    assert.strictEqual(await expander.sanitizeReferences(text), text);
  });

  test("leaves directory refs untouched", async () => {
    const root = freshWorkspace();
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "c.ts"), "// c\n");

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root],
      effectiveAbsolute: true,
    });
    const text = "List everything under @sub/ please.";

    assert.strictEqual(await expander.sanitizeReferences(text), text);
  });

  test("leaves references inside fenced code blocks untouched", async () => {
    const root = freshWorkspace();
    secondRoot = makeTempDir("cy-ctx-second-");
    const secondFile = path.join(secondRoot, "b.ts");
    fs.writeFileSync(secondFile, "export const b = true;\n");

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root, secondRoot],
      namedRoots: [
        { name: "root1", fsPath: root },
        { name: "root2", fsPath: secondRoot },
      ],
      effectiveAbsolute: true,
    });
    const text = ["Example:", "```", "@root2/b.ts", "```"].join("\n");

    assert.strictEqual(await expander.sanitizeReferences(text), text);
  });

  test("preserves surrounding prose and trailing punctuation", async () => {
    const root = freshWorkspace();
    secondRoot = makeTempDir("cy-ctx-second-");
    const secondFile = path.join(secondRoot, "b.ts");
    fs.writeFileSync(secondFile, "export const b = true;\n");

    const expander = new ContextExpander({
      workspaceRoot: root,
      additionalTrustedRoots: [root, secondRoot],
      namedRoots: [
        { name: "root1", fsPath: root },
        { name: "root2", fsPath: secondRoot },
      ],
      effectiveAbsolute: true,
    });
    const result = await expander.sanitizeReferences(
      "Have a look at @root2/b.ts, then update the tests."
    );

    assert.strictEqual(
      result,
      `Have a look at @${secondFile}, then update the tests.`
    );
  });
});
