import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { TempFileManager } from "../../utils/TempFileManager";
import { MAX_OUTPUT_SNAPSHOT_BYTES } from "../../types/DashboardConstants";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("TempFileManager", () => {
  let workspaceRoot: string;
  let manager: TempFileManager;
  const createdFiles: string[] = [];

  // Use a fresh temp workspace dir for each test to keep things isolated
  function freshManager(): TempFileManager {
    workspaceRoot = makeTempDir("cy-tmp-");
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
    removeTempDir(workspaceRoot);
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("getAttachmentsDir", () => {
    test("is the flat .ctrlyoke/attachments dir (no per-workflow subdir)", () => {
      manager = freshManager();
      assert.strictEqual(
        manager.getAttachmentsDir(),
        path.join(workspaceRoot, ".ctrlyoke", "attachments")
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("createPastedImageFile", () => {
    test("writes raw bytes to a pasted-image file in the target dir", async () => {
      manager = freshManager();
      const dir = manager.getAttachmentsDir();
      const data = Buffer.from([0, 1, 2, 3, 255]);
      const filePath = await manager.createPastedImageFile(data, "png", dir);
      createdFiles.push(filePath);
      assert.ok(
        path.basename(filePath).startsWith("pasted-image-"),
        `Expected pasted-image- prefix, got: ${filePath}`
      );
      assert.ok(filePath.endsWith(".png"));
      assert.deepStrictEqual(await fs.promises.readFile(filePath), data);
    });

    test("identical bytes dedup to a single content-addressed file", async () => {
      manager = freshManager();
      const dir = manager.getAttachmentsDir();
      const data = Buffer.from("same-image-bytes");
      const first = await manager.createPastedImageFile(data, "png", dir);
      const second = await manager.createPastedImageFile(data, "png", dir);
      createdFiles.push(first);
      assert.strictEqual(first, second, "same bytes should reuse one path");
      const images = (await fs.promises.readdir(dir)).filter((f) =>
        f.startsWith("pasted-image-")
      );
      assert.strictEqual(images.length, 1, "only one file should be written");
    });

    test("dedup is content-only: the filename ignores which workflow pasted it", async () => {
      manager = freshManager();
      const dir = manager.getAttachmentsDir();
      // Same bytes are all that matters — there is no workflow input to the
      // filename, so a second paste (conceptually from another workflow) into
      // the same flat store reuses the one file.
      const data = Buffer.from("shared-across-workflows");
      const a = await manager.createPastedImageFile(data, "png", dir);
      const b = await manager.createPastedImageFile(data, "png", dir);
      createdFiles.push(a);
      assert.strictEqual(a, b);
      const images = (await fs.promises.readdir(dir)).filter((f) =>
        f.startsWith("pasted-image-")
      );
      assert.strictEqual(images.length, 1);
    });

    test("different bytes produce different files", async () => {
      manager = freshManager();
      const dir = manager.getAttachmentsDir();
      const a = await manager.createPastedImageFile(
        Buffer.from("a"),
        "png",
        dir
      );
      const b = await manager.createPastedImageFile(
        Buffer.from("b"),
        "png",
        dir
      );
      createdFiles.push(a, b);
      assert.notStrictEqual(a, b);
    });

    test("dedup hit refreshes mtime", async () => {
      manager = freshManager();
      const dir = manager.getAttachmentsDir();
      const data = Buffer.from("touch-me");
      const filePath = await manager.createPastedImageFile(data, "png", dir);
      createdFiles.push(filePath);
      const stale = new Date(Date.now() - 60 * 60 * 1000);
      await fs.promises.utimes(filePath, stale, stale);
      const before = (await fs.promises.stat(filePath)).mtimeMs;
      await manager.createPastedImageFile(data, "png", dir);
      const after = (await fs.promises.stat(filePath)).mtimeMs;
      assert.ok(after > before, "mtime should be refreshed on a dedup hit");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("createOutputSnapshotFile", () => {
    test("writes readable range and full-channel filenames", async () => {
      manager = freshManager();
      const dir = manager.getAttachmentsDir();
      const rangePath = await manager.createOutputSnapshotFile(
        "selected output",
        "agenthost",
        { startLine: 17, endLine: 28 },
        dir
      );
      const fullPath = await manager.createOutputSnapshotFile(
        "whole output",
        "agenthost",
        undefined,
        dir
      );
      createdFiles.push(rangePath, fullPath);

      assert.match(
        path.basename(rangePath),
        /^output-agenthost-17-28-[0-9a-f]{12}\.log$/
      );
      assert.match(
        path.basename(fullPath),
        /^output-agenthost-full-[0-9a-f]{12}\.log$/
      );
      assert.strictEqual(
        await fs.promises.readFile(rangePath, "utf-8"),
        "selected output"
      );
    });

    test("truncates from the start and deduplicates identical final content", async () => {
      manager = freshManager();
      const dir = manager.getAttachmentsDir();
      const tail = "z".repeat(MAX_OUTPUT_SNAPSHOT_BYTES);
      const first = await manager.createOutputSnapshotFile(
        `a${tail}`,
        "agenthost",
        undefined,
        dir
      );
      const second = await manager.createOutputSnapshotFile(
        `b${tail}`,
        "agenthost",
        undefined,
        dir
      );
      createdFiles.push(first);

      assert.strictEqual(first, second);
      const written = await fs.promises.readFile(first, "utf-8");
      assert.ok(
        written.startsWith(
          `[ctrlyoke: output truncated — showing the last ${MAX_OUTPUT_SNAPSHOT_BYTES} of ${MAX_OUTPUT_SNAPSHOT_BYTES + 1} bytes]\n\n`
        )
      );
      assert.ok(written.endsWith(tail));
    });

    test("refreshes mtime on a dedup hit", async () => {
      manager = freshManager();
      const dir = manager.getAttachmentsDir();
      const filePath = await manager.createOutputSnapshotFile(
        "touch-me",
        "agenthost",
        undefined,
        dir
      );
      createdFiles.push(filePath);
      const stale = new Date(Date.now() - 60 * 60 * 1000);
      await fs.promises.utimes(filePath, stale, stale);
      const before = (await fs.promises.stat(filePath)).mtimeMs;
      await manager.createOutputSnapshotFile(
        "touch-me",
        "agenthost",
        undefined,
        dir
      );
      const after = (await fs.promises.stat(filePath)).mtimeMs;
      assert.ok(after > before, "mtime should be refreshed on a dedup hit");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("cleanupOrphanedFiles — pasted images", () => {
    test("sweeps old pasted images in temp; spares fresh, unrelated, and attachments", async () => {
      manager = freshManager();
      const tempDir = path.join(workspaceRoot, ".ctrlyoke", "temp");
      const oldImg = await manager.createPastedImageFile(
        Buffer.from("old"),
        "png",
        tempDir
      );
      const freshImg = await manager.createPastedImageFile(
        Buffer.from("fresh"),
        "png",
        tempDir
      );
      // Unrelated binary the user happened to drop in temp — must be spared.
      const unrelated = path.join(tempDir, "keep-me.bin");
      await fs.promises.writeFile(unrelated, Buffer.from("keep"));
      // Committed attachment image — must NEVER be swept (cleanup only scans temp).
      const attachImg = await manager.createPastedImageFile(
        Buffer.from("committed"),
        "png",
        manager.getAttachmentsDir()
      );

      const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await fs.promises.utimes(oldImg, past, past);
      await fs.promises.utimes(unrelated, past, past);
      await fs.promises.utimes(attachImg, past, past);

      await manager.cleanupOrphanedFiles();

      assert.ok(!fs.existsSync(oldImg), "old pasted image should be swept");
      assert.ok(fs.existsSync(freshImg), "fresh pasted image should remain");
      assert.ok(
        fs.existsSync(unrelated),
        "unrelated binary file should be spared"
      );
      assert.ok(
        fs.existsSync(attachImg),
        "attachment-folder image must never be swept"
      );
      createdFiles.push(freshImg, unrelated, attachImg);
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
