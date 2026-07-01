import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { TempFileManager } from "../../utils/TempFileManager";

suite("TempFileManager", () => {
  let workspaceRoot: string;
  let manager: TempFileManager;
  const createdFiles: string[] = [];

  // Use a fresh temp workspace dir for each test to keep things isolated
  function freshManager(): TempFileManager {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-tmp-"));
    return new TempFileManager(workspaceRoot);
  }

  afterEach(async () => {
    // Clean up any files we tracked
    for (const f of createdFiles.splice(0)) {
      try {
        await fs.promises.unlink(f);
      } catch {
        // best-effort
      }
    }
    // Clean up workspace dirs
    try {
      if (workspaceRoot) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("createPromptFile", () => {
    test("creates file with correct content", async () => {
      manager = freshManager();
      const content = "Hello, ctrlyoke!";
      const filePath = await manager.createPromptFile(content);
      createdFiles.push(filePath);
      const written = await fs.promises.readFile(filePath, "utf-8");
      assert.strictEqual(written, content);
    });

    test("created file exists on disk", async () => {
      manager = freshManager();
      const filePath = await manager.createPromptFile("content");
      createdFiles.push(filePath);
      await assert.doesNotReject(() => fs.promises.access(filePath));
    });

    test("filename includes workflow basename when originalFilePath provided", async () => {
      manager = freshManager();
      const origPath = "/some/path/my-workflow.ctrlyoke.json";
      const filePath = await manager.createPromptFile("prompt text", origPath);
      createdFiles.push(filePath);
      const fileName = path.basename(filePath);
      assert.ok(
        fileName.includes("my-workflow"),
        `Expected filename to contain 'my-workflow', got: ${fileName}`
      );
    });

    test("filename includes step number suffix when stepNumber provided", async () => {
      manager = freshManager();
      const filePath = await manager.createPromptFile(
        "step prompt",
        "/path/workflow.ctrlyoke.json",
        3
      );
      createdFiles.push(filePath);
      const fileName = path.basename(filePath);
      assert.ok(
        fileName.includes("-3"),
        `Expected filename to contain '-3', got: ${fileName}`
      );
    });

    test("file has .prompt.md extension", async () => {
      manager = freshManager();
      const filePath = await manager.createPromptFile("content");
      createdFiles.push(filePath);
      assert.ok(
        filePath.endsWith(".prompt.md"),
        `Expected .prompt.md extension, got: ${filePath}`
      );
    });

    test("without originalFilePath, filename uses 'prompt' as base", async () => {
      manager = freshManager();
      const filePath = await manager.createPromptFile("content");
      createdFiles.push(filePath);
      const fileName = path.basename(filePath);
      assert.ok(
        fileName.includes("prompt"),
        `Expected 'prompt' in filename, got: ${fileName}`
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("createSplitPromptFiles", () => {
    test("two chunks → two files created", async () => {
      manager = freshManager();
      const files = await manager.createSplitPromptFiles(["chunk1", "chunk2"]);
      createdFiles.push(...files);
      assert.strictEqual(files.length, 2);
      for (const f of files) {
        await assert.doesNotReject(() => fs.promises.access(f));
      }
    });

    test("single chunk → one file, no split index in name", async () => {
      manager = freshManager();
      const files = await manager.createSplitPromptFiles(["only chunk"]);
      createdFiles.push(...files);
      assert.strictEqual(files.length, 1);
      const name = path.basename(files[0]);
      // Single chunk should NOT have ".1." split suffix
      assert.ok(
        !name.match(/\.\d+\.prompt\.md$/),
        `Unexpected split index in: ${name}`
      );
    });

    test("two chunks → filenames contain .1. and .2. split indices", async () => {
      manager = freshManager();
      const files = await manager.createSplitPromptFiles(["first", "second"]);
      createdFiles.push(...files);
      assert.ok(
        path.basename(files[0]).includes(".1."),
        `Expected .1. in first file: ${files[0]}`
      );
      assert.ok(
        path.basename(files[1]).includes(".2."),
        `Expected .2. in second file: ${files[1]}`
      );
    });

    test("each file contains its respective chunk content", async () => {
      manager = freshManager();
      const files = await manager.createSplitPromptFiles(["alpha", "beta"]);
      createdFiles.push(...files);
      const first = await fs.promises.readFile(files[0], "utf-8");
      const second = await fs.promises.readFile(files[1], "utf-8");
      assert.strictEqual(first, "alpha");
      assert.strictEqual(second, "beta");
    });

    test("empty array → throws", async () => {
      manager = freshManager();
      await assert.rejects(
        () => manager.createSplitPromptFiles([]),
        /no chunks provided/i
      );
    });

    test("array of only blank strings → throws", async () => {
      manager = freshManager();
      await assert.rejects(
        () => manager.createSplitPromptFiles(["   ", "\t"]),
        /all chunks are empty/i
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("getRelativePath", () => {
    test("returns workspace-relative path for a file inside workspaceRoot", () => {
      manager = freshManager();
      const abs = path.join(
        workspaceRoot,
        ".ctrlyoke",
        "temp",
        "some.prompt.md"
      );
      const rel = manager.getRelativePath(abs);
      assert.ok(!path.isAbsolute(rel), "result should be relative");
      assert.ok(rel.includes(".ctrlyoke"), "should contain .ctrlyoke segment");
    });
  });
});
