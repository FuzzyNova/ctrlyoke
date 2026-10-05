import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  commitGeneratedChanges,
  generateCommitMessageForChanges,
} from "../../cli/CommitCommand";
import { CommitMessageGenerator } from "../../git/CommitMessageGenerator";
import { GitCommitter } from "../../git/GitCommitter";

suite("CLI commit command", () => {
  test("--all generates its message from staged, unstaged, and untracked changes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cy-cli-commit-all-"));
    const runGit = (args: string[]): string =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    try {
      runGit(["init"]);
      runGit(["config", "user.name", "CtrlYoke Tests"]);
      runGit(["config", "user.email", "ctrlyoke-tests@example.com"]);
      await fs.writeFile(path.join(cwd, "a.txt"), "a before\n", "utf8");
      await fs.writeFile(path.join(cwd, "b.txt"), "b before\n", "utf8");
      runGit(["add", "a.txt", "b.txt"]);
      runGit(["commit", "-m", "Initial commit"]);
      await fs.writeFile(path.join(cwd, "a.txt"), "staged a change\n", "utf8");
      runGit(["add", "a.txt"]);
      await fs.writeFile(
        path.join(cwd, "b.txt"),
        "unstaged b change\n",
        "utf8"
      );
      await fs.writeFile(
        path.join(cwd, "c.txt"),
        "untracked c change\n",
        "utf8"
      );

      const realGenerator = new CommitMessageGenerator();
      let generatedDiff = "";
      const result = await generateCommitMessageForChanges(
        {
          getDiff: realGenerator.getDiff.bind(realGenerator),
          async generateMessage(
            diff
          ): Promise<{ message: string; prompt: string }> {
            generatedDiff = diff;
            return { message: "feat: cover all changes", prompt: "" };
          },
        },
        cwd,
        { all: true }
      );

      assert.ok(result.diffResult);
      assert.ok(generatedDiff.includes("staged a change"));
      assert.ok(generatedDiff.includes("unstaged b change"));
      assert.ok(generatedDiff.includes("untracked c change"));
    } finally {
      await fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });

  test("does not confirm or attempt an unstaged-only change", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cy-cli-commit-"));
    const runGit = (args: string[]): string =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    try {
      runGit(["init"]);
      runGit(["config", "user.name", "CtrlYoke Tests"]);
      runGit(["config", "user.email", "ctrlyoke-tests@example.com"]);
      await fs.writeFile(path.join(cwd, "tracked.txt"), "before\n", "utf8");
      runGit(["add", "tracked.txt"]);
      runGit(["commit", "-m", "Initial commit"]);
      await fs.writeFile(
        path.join(cwd, "tracked.txt"),
        "unstaged edit\n",
        "utf8"
      );

      const realGenerator = new CommitMessageGenerator();
      const diff = await realGenerator.getDiff(cwd);
      assert.ok(diff);
      let generationCalls = 0;
      const generator = {
        async generateMessage(): Promise<{ message: string }> {
          generationCalls++;
          return { message: "fix: keep unstaged work safe" };
        },
      };
      const { message } = await generator.generateMessage();
      let confirmationCalls = 0;

      const result = await commitGeneratedChanges(
        diff,
        message,
        cwd,
        { yes: true },
        new GitCommitter(),
        async () => {
          confirmationCalls++;
          return true;
        }
      );

      assert.strictEqual(generationCalls, 1);
      assert.strictEqual(result, "requires-staging");
      assert.strictEqual(confirmationCalls, 0);
      assert.strictEqual(runGit(["rev-list", "--count", "HEAD"]), "1");
      assert.strictEqual(
        await fs.readFile(path.join(cwd, "tracked.txt"), "utf8"),
        "unstaged edit\n"
      );
    } finally {
      await fs
        .rm(cwd, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });

  test("--all stages the repository root when invoked from a subdirectory", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cy-cli-commit-root-")
    );
    const subdir = path.join(root, "nested", "folder");
    const runGit = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    try {
      await fs.mkdir(subdir, { recursive: true });
      runGit(["init"]);
      runGit(["config", "user.name", "CtrlYoke Tests"]);
      runGit(["config", "user.email", "ctrlyoke-tests@example.com"]);
      await fs.writeFile(path.join(root, "root.txt"), "before\n", "utf8");
      runGit(["add", "root.txt"]);
      runGit(["commit", "-m", "Initial commit"]);
      await fs.writeFile(path.join(root, "root.txt"), "root change\n", "utf8");
      await fs.writeFile(
        path.join(root, "nested.txt"),
        "nested change\n",
        "utf8"
      );

      await new GitCommitter().commit(
        "feat: include repository changes",
        subdir,
        {
          addAll: true,
        }
      );

      const changedFiles = runGit(["show", "--format=", "--name-only"])
        .split(/\r?\n/)
        .filter(Boolean);
      assert.deepStrictEqual(changedFiles.sort(), ["nested.txt", "root.txt"]);
    } finally {
      await fs
        .rm(root, { recursive: true, force: true, maxRetries: 5 })
        .catch(() => {});
    }
  });
});
