import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import {
  clearBranchCompletionCache,
  getBranchCompletions,
} from "../../completions/BranchCompletionHelpers";

suite("BranchCompletionHelpers", function () {
  let workspaceRoot: string;

  function runGit(args: string[]): string {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  }

  async function createRepository(withCommit = true): Promise<void> {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-branch-completions-")
    );
    runGit(["init"]);
    if (withCommit) {
      runGit(["config", "user.name", "ctrlyoke Tests"]);
      runGit(["config", "user.email", "ctrlyoke-tests@example.com"]);
      await fs.writeFile(path.join(workspaceRoot, "tracked.txt"), "base\n");
      runGit(["add", "tracked.txt"]);
      runGit(["commit", "-m", "Initial commit"]);
    }
  }

  setup(() => {
    clearBranchCompletionCache();
  });

  teardown(async () => {
    clearBranchCompletionCache();
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  test("filters branch names by a case-insensitive prefix", async () => {
    await createRepository();
    runGit(["branch", "feat/one"]);
    runGit(["branch", "fix-123"]);

    const items = await getBranchCompletions(workspaceRoot, "FEAT/");

    assert.deepStrictEqual(
      items.map((item) => ({
        label: item.label,
        insertText: item.insertText,
        detail: item.detail,
      })),
      [
        {
          label: "feat/one",
          insertText: "feat/one",
          detail: "Existing branch",
        },
      ]
    );
  });

  test("uses the cached branch list until the 10-second TTL expires", async () => {
    await createRepository();
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;

    try {
      await getBranchCompletions(workspaceRoot, "");
      runGit(["branch", "created-after-cache"]);

      const cachedItems = await getBranchCompletions(workspaceRoot, "");
      assert.ok(
        !cachedItems.some((item) => item.label === "created-after-cache")
      );

      now += 10_001;
      const refreshedItems = await getBranchCompletions(workspaceRoot, "");
      assert.ok(
        refreshedItems.some((item) => item.label === "created-after-cache")
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("returns no items without a workspace folder or for a non-repository", async () => {
    assert.deepStrictEqual(await getBranchCompletions(undefined, ""), []);

    await createRepository(false);
    assert.deepStrictEqual(await getBranchCompletions(workspaceRoot, ""), []);
  });

  test("returns no items for a repository with no local branches", async () => {
    await createRepository(false);

    assert.deepStrictEqual(await getBranchCompletions(workspaceRoot, ""), []);
  });

  test("returns no items when the typed prefix matches nothing", async () => {
    await createRepository();

    assert.deepStrictEqual(
      await getBranchCompletions(workspaceRoot, "does-not-exist"),
      []
    );
  });
});
