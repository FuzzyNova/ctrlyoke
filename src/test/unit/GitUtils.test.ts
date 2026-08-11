import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, test, setup, teardown } from "mocha";
import {
  gitRefExists,
  parseGitWorktreePorcelain,
  listWorktrees,
  currentBranch,
  resolveCommit,
  hasUncommittedChanges,
  commitAll,
  addWorktree,
  removeWorktree,
  GitWorktreeBranchCheckoutError,
  absoluteGitDir,
  gitCommonDir,
  gitPath,
} from "../../utils/GitUtils";

suite("GitUtils.gitRefExists", function () {
  // Setup shells out to real git (init/config/commit) via execFileSync.
  // `this.timeout()` in a test callback only extends that test's own
  // runnable, not the "before each" hook ahead of it, so the timeout needs
  // to be set at suite level to keep `setup` from timing out while the full
  // extension host suite is probing installed harness CLIs in parallel.
  this.timeout(10_000);

  let workspaceRoot: string;

  function runGit(args: string[]): string {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  }

  async function writeWorkspaceFile(
    relativePath: string,
    content: string
  ): Promise<void> {
    const absolutePath = path.join(workspaceRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fp-gitutils-"));
    runGit(["init"]);
    runGit(["config", "user.name", "ctrlyoke Tests"]);
    runGit(["config", "user.email", "ctrlyoke-tests@example.com"]);
    await writeWorkspaceFile("tracked.txt", "base\n");
    runGit(["add", "tracked.txt"]);
    runGit(["commit", "-m", "Initial commit"]);
  });

  teardown(async () => {
    // Windows can hold transient locks on git pack files (which are also
    // read-only), causing EBUSY/EPERM. maxRetries makes rm retry those.
    await fs.rm(workspaceRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  test("reports the diff pseudo-ref as missing when the tree is clean", async () => {
    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "diff"), {
      exists: false,
      message: "git diff not found",
    });
  });

  test("reports the diff pseudo-ref as present when the tree is dirty", async () => {
    await writeWorkspaceFile("tracked.txt", "changed\n");

    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "diff"), {
      exists: true,
    });
  });

  test("reports the staged pseudo-ref as missing when the index is empty", async () => {
    await writeWorkspaceFile("tracked.txt", "changed but unstaged\n");

    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "staged"), {
      exists: false,
      message: "staged changes not found",
    });
  });

  test("reports the staged pseudo-ref as present once changes are staged", async () => {
    await writeWorkspaceFile("tracked.txt", "changed\n");
    runGit(["add", "tracked.txt"]);

    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "staged"), {
      exists: true,
    });
  });

  test("resolves full and abbreviated commit hashes", async () => {
    const fullHash = runGit(["rev-parse", "HEAD"]);
    const shortHash = runGit(["rev-parse", "--short=8", "HEAD"]);

    assert.deepStrictEqual(await gitRefExists(workspaceRoot, fullHash), {
      exists: true,
    });
    assert.deepStrictEqual(await gitRefExists(workspaceRoot, shortHash), {
      exists: true,
    });
  });

  test("reports an unknown commit hash as missing", async () => {
    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "0".repeat(40)), {
      exists: false,
      message: "git context not found",
    });
  });

  test("reports an unrecognized ref as missing without invoking git", async () => {
    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "stash:0"), {
      exists: false,
      message: "git context not found",
    });
    assert.deepStrictEqual(await gitRefExists(workspaceRoot, "not-a-ref"), {
      exists: false,
      message: "git context not found",
    });
  });

  test("swallows git failures and reports the ref as missing", async () => {
    const missingRoot = path.join(workspaceRoot, "does-not-exist");

    assert.deepStrictEqual(await gitRefExists(missingRoot, "diff"), {
      exists: false,
      message: "git context not found",
    });
  });
});

suite("GitUtils worktree plumbing", function () {
  this.timeout(10_000);

  let workspaceRoot: string;

  function runGit(args: string[]): string {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  }

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "fp-worktree-git-")
    );
    runGit(["init"]);
    runGit(["config", "user.name", "ctrlyoke Tests"]);
    runGit(["config", "user.email", "ctrlyoke-tests@example.com"]);
    await fs.writeFile(path.join(workspaceRoot, "tracked.txt"), "base\n");
    runGit(["add", "tracked.txt"]);
    runGit(["commit", "-m", "Initial commit"]);
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  test("parses NUL-delimited records without damaging awkward paths", () => {
    const output =
      "worktree C:/repo/space path/line\nname\0" +
      "HEAD abc123\0branch refs/heads/feature/odd\0\0" +
      "worktree /repo/detached\0HEAD def456\0detached\0locked held by user\0" +
      "prunable missing\0\0";

    assert.deepStrictEqual(parseGitWorktreePorcelain(output), [
      {
        worktreePath: path.normalize("C:/repo/space path/line\nname"),
        headCommit: "abc123",
        branchName: "feature/odd",
        detached: false,
        bare: false,
        lockedReason: undefined,
        prunableReason: undefined,
      },
      {
        worktreePath: path.normalize("/repo/detached"),
        headCommit: "def456",
        branchName: undefined,
        detached: true,
        bare: false,
        lockedReason: "held by user",
        prunableReason: "missing",
      },
    ]);
  });

  test("lists the repository worktree and exposes branch identity", async () => {
    const entries = await listWorktrees(workspaceRoot);
    assert.strictEqual(entries.length, 1);
    assert.ok(entries[0].branchName);
    assert.strictEqual(
      await currentBranch(workspaceRoot),
      entries[0].branchName
    );
    assert.strictEqual((await resolveCommit(workspaceRoot, "HEAD")).length, 40);
    assert.ok((await absoluteGitDir(workspaceRoot))?.endsWith(".git"));
    assert.ok((await gitCommonDir(workspaceRoot))?.endsWith(".git"));
    assert.ok(
      (await gitPath(workspaceRoot, "HEAD"))?.endsWith(
        ".git" + path.sep + "HEAD"
      )
    );
  });

  test("detects and commits changes through argv-only Git calls", async () => {
    assert.strictEqual(await hasUncommittedChanges(workspaceRoot), false);
    await fs.writeFile(path.join(workspaceRoot, "tracked.txt"), "changed\n");
    assert.strictEqual(await hasUncommittedChanges(workspaceRoot), true);
    assert.strictEqual(
      await commitAll(workspaceRoot, "safe message; no shell"),
      true
    );
    assert.strictEqual(await hasUncommittedChanges(workspaceRoot), false);
  });

  test("reports the existing checkout when a branch is already attached", async () => {
    const attached = path.join(
      path.dirname(workspaceRoot),
      "attached-worktree"
    );
    await addWorktree(workspaceRoot, attached, {
      branchName: "secondary",
      createBranch: true,
    });
    await assert.rejects(
      addWorktree(
        workspaceRoot,
        path.join(path.dirname(workspaceRoot), "duplicate"),
        {
          branchName: "secondary",
        }
      ),
      (error: unknown) =>
        error instanceof GitWorktreeBranchCheckoutError &&
        error.existingWorktreePath === path.normalize(attached)
    );
    await removeWorktree(workspaceRoot, attached);
  });
});
