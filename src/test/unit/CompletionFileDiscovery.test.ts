import * as assert from "assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { suite, test } from "mocha";
import {
  cacheSourceFiles,
  getSourceFiles,
} from "../../utils/CompletionFileDiscovery";

suite("CompletionFileDiscovery", () => {
  test("returns Git-visible paths without traversing ignored source trees", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-completion-discovery-")
    );
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
      await fs.writeFile(
        path.join(root, ".gitignore"),
        "ignored.txt\nignored-directory/\n"
      );
      await fs.mkdir(path.join(root, "ignored-directory", "nested"), {
        recursive: true,
      });
      await fs.writeFile(path.join(root, "ignored.txt"), "ignored");
      await fs.writeFile(
        path.join(root, "ignored-directory", "nested", "file.txt"),
        "ignored"
      );

      const files = await getSourceFiles(root);
      assert.ok(!files.includes("ignored.txt"));
      assert.ok(!files.includes("ignored-directory/nested/file.txt"));
    } finally {
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  test("includes untracked non-ignored files", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-completion-discovery-order-")
    );
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
      await fs.writeFile(path.join(root, ".gitignore"), "aaa-ignored/\n");
      await fs.mkdir(path.join(root, "aaa-ignored"));
      await fs.mkdir(path.join(root, "zzz-visible"));
      await fs.writeFile(path.join(root, "aaa-ignored", "file.md"), "");
      await fs.writeFile(path.join(root, "zzz-visible", "file.md"), "");

      const files = await getSourceFiles(root);
      assert.ok(files.includes("zzz-visible/file.md"));
      assert.ok(!files.includes("aaa-ignored/file.md"));
    } finally {
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  test("cacheSourceFiles shares one listing and retries after a failure", async () => {
    let loads = 0;
    let fail = true;
    const cached = cacheSourceFiles(async () => {
      loads++;
      if (fail) throw new Error("git failed");
      return ["a.ts"];
    }, 60_000);
    await assert.rejects(cached());
    fail = false;
    const [first, second] = await Promise.all([cached(), cached()]);
    assert.deepStrictEqual(first, ["a.ts"]);
    assert.strictEqual(first, second);
    assert.strictEqual(loads, 2);
  });
});
