import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  isSearchPathIgnored,
  walkSearchFiles,
} from "../../utils/WorkspaceSearchFileWalker";

suite("WorkspaceSearchFileWalker", () => {
  test("walks files relative to the root and skips generated directories", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-search-walk-")
    );
    try {
      await fs.mkdir(path.join(root, "src"));
      await fs.mkdir(path.join(root, "node_modules"));
      await fs.writeFile(path.join(root, "src", "main.ts"), "source");
      await fs.writeFile(
        path.join(root, "node_modules", "ignored.js"),
        "ignored"
      );

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

  test("shares completion exclusions for generated paths and ctrlyoke logs", () => {
    assert.strictEqual(isSearchPathIgnored("src/.git/config"), true);
    assert.strictEqual(isSearchPathIgnored("node_modules/pkg/index.js"), true);
    assert.strictEqual(isSearchPathIgnored(".ctrlyoke/logs/session.log"), true);
    assert.strictEqual(isSearchPathIgnored("logs/session.log"), false);
    assert.strictEqual(isSearchPathIgnored("src/main.ts"), false);
  });

  test("does not walk ctrlyoke log output", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-search-logs-")
    );
    try {
      await fs.mkdir(path.join(root, ".ctrlyoke", "logs"), { recursive: true });
      await fs.mkdir(path.join(root, "src"));
      await fs.writeFile(
        path.join(root, ".ctrlyoke", "logs", "session.log"),
        "log"
      );
      await fs.writeFile(path.join(root, "src", "main.ts"), "source");

      const result = await walkSearchFiles(root, Date.now(), 10, 10_000);
      assert.deepStrictEqual(result.files, [path.join("src", "main.ts")]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
