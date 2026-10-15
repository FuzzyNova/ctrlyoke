import * as assert from "assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { suite, test } from "mocha";
import { listCompletionFiles } from "../../utils/CompletionFileDiscovery";

suite("CompletionFileDiscovery", () => {
  test("respects Git ignore rules only when the setting is enabled", async () => {
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

      const respecting = await listCompletionFiles(root, {
        respectGitignore: true,
      });
      assert.ok(!respecting.includes("ignored.txt"));
      assert.ok(
        !respecting.includes(path.join("ignored-directory", "nested", "file.txt"))
      );

      const including = await listCompletionFiles(root, {
        respectGitignore: false,
      });
      assert.ok(including.includes("ignored.txt"));
      assert.ok(
        including.includes(path.join("ignored-directory", "nested", "file.txt"))
      );
    } finally {
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });
});
