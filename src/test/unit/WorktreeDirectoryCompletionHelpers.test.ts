import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import {
  clearWorktreeDirectoryCompletionCache,
  getWorktreeDirectoryCompletions,
} from "../../completions/WorktreeDirectoryCompletionHelpers";

suite("WorktreeDirectoryCompletionHelpers", function () {
  let parent: string;
  let repository: string;

  function runGit(args: string[]): void {
    execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
  }

  setup(async () => {
    clearWorktreeDirectoryCompletionCache();
    parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-worktree-directories-")
    );
    repository = path.join(parent, "repository");
    await fs.mkdir(repository);
    execFileSync("git", ["init", repository], { stdio: "ignore" });
    runGit(["config", "user.name", "ctrlyoke Tests"]);
    runGit(["config", "user.email", "ctrlyoke-tests@example.com"]);
    await fs.writeFile(path.join(repository, "tracked.txt"), "base\n");
    runGit(["add", "tracked.txt"]);
    runGit(["commit", "-m", "Initial commit"]);
  });

  teardown(async () => {
    clearWorktreeDirectoryCompletionCache();
    await fs.rm(parent, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  test("suggests linked worktree directories by case-insensitive prefix with their branch", async () => {
    runGit([
      "worktree",
      "add",
      "-b",
      "fix-race-condition",
      path.join(parent, "bug-fix"),
    ]);
    runGit(["worktree", "add", "-b", "paging", path.join(parent, "feature")]);

    const items = await getWorktreeDirectoryCompletions(repository, "BUG");

    assert.deepStrictEqual(
      items.map(({ label, insertText, detail }) => ({
        label,
        insertText,
        detail,
      })),
      [
        {
          label: "bug-fix",
          insertText: "bug-fix",
          detail: "on fix-race-condition",
        },
      ]
    );
  });

  test("uses full paths for duplicate directory names and bare names for unique ones", async () => {
    const firstPath = path.join(parent, "first", "feature");
    const secondPath = path.join(parent, "second", "feature");
    const uniquePath = path.join(parent, "unique");
    await fs.mkdir(path.dirname(firstPath));
    await fs.mkdir(path.dirname(secondPath));
    runGit(["worktree", "add", "-b", "feature-one", firstPath]);
    runGit(["worktree", "add", "-b", "feature-two", secondPath]);
    runGit(["worktree", "add", "-b", "unique-branch", uniquePath]);

    const items = await getWorktreeDirectoryCompletions(repository, "");
    assert.deepStrictEqual(
      items.map(({ label, insertText }) => ({ label, insertText })),
      [
        { label: "feature", insertText: firstPath },
        { label: "feature", insertText: secondPath },
        { label: "unique", insertText: "unique" },
      ]
    );
  });

  test("returns nothing without a repository root", async () => {
    assert.deepStrictEqual(
      await getWorktreeDirectoryCompletions(undefined, ""),
      []
    );
  });
});
