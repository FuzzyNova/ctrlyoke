import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, test, setup, teardown } from "mocha";
import {
  gitRefExists,
  getGitIgnoredFiles,
  parseGitWorktreePorcelain,
  listWorktrees,
  currentBranch,
  listLocalBranches,
  resolveCommit,
  hasUncommittedChanges,
  commitAll,
  addWorktree,
  removeWorktree,
  GitWorktreeBranchCheckoutError,
  absoluteGitDir,
  gitCommonDir,
  gitPath,
  getAheadBehind,
  getBranchUpstream,
  isCommitAncestor,
  getBlobBytes,
  getFileHistoryCommits,
  getRecentCommits,
  getChangedFilesWithBinaryStatus,
} from "../../utils/GitUtils";

suite("GitUtils.gitRefExists", function () {
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
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy-gitutils-"));
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

  test("reads existing blobs as bytes and returns null for missing blobs", async () => {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await fs.writeFile(path.join(workspaceRoot, "image.png"), imageBytes);
    runGit(["add", "image.png"]);
    runGit(["commit", "-m", "Add image"]);

    assert.deepStrictEqual(
      await getBlobBytes(workspaceRoot, "HEAD", "image.png"),
      imageBytes
    );
    assert.strictEqual(
      await getBlobBytes(workspaceRoot, "HEAD", "missing.png"),
      null
    );
  });

  test("classifies binary and text changes from one numstat query", async () => {
    await writeWorkspaceFile("text.txt", "changed\n");
    await fs.writeFile(
      path.join(workspaceRoot, "binary.bin"),
      Buffer.from([0, 1, 2])
    );
    runGit(["add", "text.txt", "binary.bin"]);

    const changed = await getChangedFilesWithBinaryStatus(workspaceRoot, [
      "diff",
      "--cached",
    ]);

    assert.deepStrictEqual(
      changed.map(({ path: filePath, isBinary, status }) => ({
        path: filePath,
        isBinary,
        status,
      })),
      [
        { path: "binary.bin", isBinary: true, status: "A" },
        { path: "text.txt", isBinary: false, status: "A" },
      ]
    );
  });

  test("returns path history newest first and preserves rename pairs", async () => {
    runGit(["mv", "tracked.txt", "renamed.txt"]);
    runGit(["commit", "-am", "Rename tracked file"]);
    await writeWorkspaceFile("renamed.txt", "latest\n");
    runGit(["commit", "-am", "Update renamed file"]);

    const history = await getFileHistoryCommits(
      workspaceRoot,
      "renamed.txt",
      undefined
    );

    assert.deepStrictEqual(
      history.map((entry) => entry.subject),
      ["Update renamed file", "Rename tracked file", "Initial commit"]
    );
    assert.strictEqual(history[1]?.oldPath, "tracked.txt");
    assert.strictEqual(history[1]?.path, "renamed.txt");
    assert.deepStrictEqual(history[2]?.parentHashes, []);
    assert.strictEqual(history[2]?.oldPath, "tracked.txt");
    assert.strictEqual(history[2]?.path, "tracked.txt");
  });

  test("fetches the complete recent history when limit is undefined", async () => {
    await writeWorkspaceFile("second.txt", "second\n");
    runGit(["add", "second.txt"]);
    runGit(["commit", "-m", "Second commit"]);
    await writeWorkspaceFile("third.txt", "third\n");
    runGit(["add", "third.txt"]);
    runGit(["commit", "-m", "Third commit"]);

    const history = await getRecentCommits(workspaceRoot, undefined);

    assert.deepStrictEqual(
      history.map((entry) => entry.subject),
      ["Third commit", "Second commit", "Initial commit"]
    );
  });
});

suite("GitUtils worktree plumbing", function () {
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
      path.join(os.tmpdir(), "cy-worktree-git-")
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

  test("lists local branches in Git's recency order", async () => {
    runGit(["branch", "feature"]);

    const branches = await listLocalBranches(workspaceRoot);
    const branch = await currentBranch(workspaceRoot);

    assert.ok(branches.includes("feature"));
    assert.ok(branch !== null && branches.includes(branch));
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

  test("computes labeled ahead/behind counts without syncing", async () => {
    runGit(["checkout", "-b", "feature"]);
    await fs.writeFile(path.join(workspaceRoot, "tracked.txt"), "feature\n");
    runGit(["add", "tracked.txt"]);
    runGit(["commit", "-m", "Feature"]);
    runGit(["checkout", "-b", "base", "HEAD~1"]);
    runGit(["checkout", "feature"]);
    runGit(["branch", "--set-upstream-to=base", "feature"]);

    assert.deepStrictEqual(
      await getAheadBehind(workspaceRoot, "base", "feature"),
      { ahead: 1, behind: 0 }
    );
    assert.strictEqual(
      await getBranchUpstream(workspaceRoot, "feature"),
      "base"
    );
    assert.strictEqual(
      await isCommitAncestor(workspaceRoot, "base", "feature"),
      true
    );
  });
});

suite("GitUtils.getGitIgnoredFiles", function () {
  const temporaryRoots: string[] = [];

  async function createRepo(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cy-gitignored-"));
    temporaryRoots.push(root);
    execFileSync("git", ["init"], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
    return root;
  }

  async function writeRepoFile(
    root: string,
    relativePath: string,
    content: string
  ): Promise<void> {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }

  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  test("lists root and nested ignored files recursively", async () => {
    const root = await createRepo();
    await writeRepoFile(root, ".gitignore", "*.log\nignored-directory/\n");
    await writeRepoFile(root, "root.log", "ignored\n");
    await writeRepoFile(root, "ignored-directory/one.txt", "ignored\n");
    await writeRepoFile(root, "ignored-directory/nested/two.txt", "ignored\n");
    await writeRepoFile(root, "nested/.gitignore", "secret.txt\n");
    await writeRepoFile(root, "nested/secret.txt", "ignored\n");
    await writeRepoFile(root, "nested/visible.txt", "visible\n");

    const ignoredFiles = await getGitIgnoredFiles(root);

    assert.deepStrictEqual(
      ignoredFiles.sort(),
      [
        "ignored-directory/nested/two.txt",
        "ignored-directory/one.txt",
        "nested/secret.txt",
        "root.log",
      ].sort()
    );
    assert.ok(ignoredFiles.includes("ignored-directory/one.txt"));
    assert.ok(ignoredFiles.includes("ignored-directory/nested/two.txt"));
    assert.ok(!ignoredFiles.includes("ignored-directory/"));
  });

  test("returns an empty list when nothing is ignored", async () => {
    const root = await createRepo();
    await writeRepoFile(root, "visible.txt", "visible\n");
    await writeRepoFile(root, "nested/also-visible.txt", "visible\n");

    assert.deepStrictEqual(await getGitIgnoredFiles(root), []);
  });
});
