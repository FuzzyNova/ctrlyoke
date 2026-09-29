import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { commitGeneratedChanges } from "../../cli/CommitCommand";
import { CommitMessageGenerator } from "../../git/CommitMessageGenerator";
import { GitCommitter } from "../../git/GitCommitter";

suite("CLI commit command", () => {
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
});
