import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { walkSearchFiles } from "../../utils/WorkspaceSearchFileWalker";

suite("WorkspaceSearchFileWalker", () => {
  test("walks files relative to the root and skips generated directories", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-search-walk-")
    );
    try {
      await fs.mkdir(path.join(root, "src"));
      await fs.mkdir(path.join(root, "node_modules"));
      await fs.writeFile(path.join(root, "src", "main.ts"), "source");
      await fs.writeFile(path.join(root, "node_modules", "ignored.js"), "ignored");

      const result = await walkSearchFiles(root, Date.now(), 10, 10_000);
      assert.deepStrictEqual(result, {
        files: [path.join("src", "main.ts")],
        truncated: false,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("marks a walk truncated when the file limit leaves pending work", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-search-limit-")
    );
    try {
      await fs.mkdir(path.join(root, "nested"));
      await fs.writeFile(path.join(root, "first.txt"), "first");
      await fs.writeFile(path.join(root, "nested", "second.txt"), "second");

      const result = await walkSearchFiles(root, Date.now(), 1, 10_000);
      assert.strictEqual(result.files.length, 1);
      assert.strictEqual(result.truncated, true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
