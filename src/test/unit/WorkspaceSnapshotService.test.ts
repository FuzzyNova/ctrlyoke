import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, test, setup, teardown } from "mocha";
import { WorkspaceSnapshotService } from "../../utils/WorkspaceSnapshotService";
import {
  SNAPSHOT_STRATEGIES,
  UNDO_FILE_ACTIONS,
} from "../../types/DashboardConstants";

suite("WorkspaceSnapshotService", function () {
  let workspaceRoot: string;
  let snapshotService: WorkspaceSnapshotService;

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

  async function initializeRepo(): Promise<void> {
    runGit(["init"]);
    runGit(["config", "user.name", "ctrlyoke Tests"]);
    runGit(["config", "user.email", "ctrlyoke-tests@example.com"]);
    await writeWorkspaceFile("tracked.txt", "base\n");
    await writeWorkspaceFile("old.txt", "rename source\n");
    await writeWorkspaceFile("café.txt", "coffee\n");
    runGit(["add", "tracked.txt"]);
    runGit(["add", "old.txt", "café.txt"]);
    runGit(["commit", "-m", "Initial commit"]);
  }

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cy-snapshot-"));
    snapshotService = new WorkspaceSnapshotService();
    await initializeRepo();
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

  test("ignores files that were already dirty and only became clean because they were committed", async () => {
    await writeWorkspaceFile("tracked.txt", "dirty before prompt\n");

    const beforeState = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );

    runGit(["add", "tracked.txt"]);
    runGit(["commit", "-m", "Commit existing workspace change"]);

    const afterState = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    const changes = await snapshotService.computeSnapshotChanges(
      beforeState,
      afterState,
      workspaceRoot
    );

    assert.strictEqual(afterState.segments[0].files.size, 0);
    assert.deepStrictEqual(changes, []);
  });

  test("records a deleted tracked file and its HEAD content for undo", async () => {
    const before = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    await fs.rm(path.join(workspaceRoot, "tracked.txt"));

    const after = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    const changes = await snapshotService.computeSnapshotChanges(
      before,
      after,
      workspaceRoot
    );

    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0]?.changeType, "deleted");
    assert.strictEqual(changes[0]?.contentToRestore, "base\n");
  });

  test("scopes a single-root git snapshot to a workspace below the repo root", async () => {
    const packageRoot = path.join(workspaceRoot, "packages", "foo");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, "modified.txt"), "base\n");
    await fs.writeFile(path.join(packageRoot, "deleted.txt"), "restore me\n");
    await fs.writeFile(path.join(workspaceRoot, "outside.txt"), "outside base\n");
    runGit(["add", "packages/foo/modified.txt", "packages/foo/deleted.txt", "outside.txt"]);
    runGit(["commit", "-m", "Add package files"]);

    const before = await snapshotService.captureWorkspaceState(
      packageRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    await fs.writeFile(path.join(packageRoot, "modified.txt"), "changed\n");
    await fs.rm(path.join(packageRoot, "deleted.txt"));
    await fs.writeFile(path.join(workspaceRoot, "outside.txt"), "outside changed\n");

    const after = await snapshotService.captureWorkspaceState(
      packageRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    const changes = await snapshotService.computeSnapshotChanges(
      before,
      after,
      packageRoot
    );
    assert.deepStrictEqual(
      changes.map(({ path: filePath, changeType }) => ({ filePath, changeType }))
        .sort((a, b) => a.filePath.localeCompare(b.filePath)),
      [
        { filePath: "deleted.txt", changeType: "deleted" },
        { filePath: "modified.txt", changeType: "modified" },
      ]
    );
    const deleted = changes.find((change) => change.path === "deleted.txt");
    assert.strictEqual(deleted?.contentToRestore, "restore me\n");

    const undo = await snapshotService.undoFiles(
      [
        {
          path: "deleted.txt",
          action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
          contentToRestore: deleted?.contentToRestore,
        },
      ],
      packageRoot
    );
    assert.deepStrictEqual(undo.restoredFiles, ["deleted.txt"]);
    assert.strictEqual(
      await fs.readFile(path.join(packageRoot, "deleted.txt"), "utf8"),
      "restore me\n"
    );
    await assert.rejects(() =>
      fs.access(path.join(packageRoot, "packages", "foo", "deleted.txt"))
    );
  });

  test("captures files inside a newly created untracked directory", async () => {
    const before = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    await writeWorkspaceFile("newdir/a.ts", "export const value = 1;\n");

    const after = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    const changes = await snapshotService.computeSnapshotChanges(
      before,
      after,
      workspaceRoot
    );

    assert.deepStrictEqual(
      changes.map(({ path: filePath, changeType }) => ({
        filePath,
        changeType,
      })),
      [{ filePath: "newdir/a.ts", changeType: "created" }]
    );
  });

  test("records staged renames as a deletion and creation", async () => {
    const before = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    runGit(["mv", "old.txt", "new.txt"]);

    const after = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    const changes = await snapshotService.computeSnapshotChanges(
      before,
      after,
      workspaceRoot
    );

    assert.deepStrictEqual(
      changes
        .map(({ path: filePath, changeType }) => ({ filePath, changeType }))
        .sort((a, b) => a.filePath.localeCompare(b.filePath)),
      [
        { filePath: "new.txt", changeType: "created" },
        { filePath: "old.txt", changeType: "deleted" },
      ]
    );
    assert.strictEqual(
      changes.find(({ path: filePath }) => filePath === "old.txt")
        ?.contentToRestore,
      "rename source\n"
    );
  });

  test("preserves non-ASCII paths in dirty snapshots", async () => {
    const before = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    await writeWorkspaceFile("café.txt", "espresso\n");

    const after = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    const changes = await snapshotService.computeSnapshotChanges(
      before,
      after,
      workspaceRoot
    );

    assert.strictEqual(changes[0]?.path, "café.txt");
    assert.strictEqual(changes[0]?.changeType, "modified");
  });

  test("preserves non-ASCII paths in committed changes", async () => {
    const before = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    await writeWorkspaceFile("naïve.txt", "committed during prompt\n");
    runGit(["add", "naïve.txt"]);
    runGit(["commit", "-m", "Add naïve file"]);

    const after = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    const changes = await snapshotService.computeSnapshotChanges(
      before,
      after,
      workspaceRoot
    );

    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0]?.path, "naïve.txt");
    assert.strictEqual(changes[0]?.changeType, "created");
  });

  test("keeps committed tracked files as modified when the prompt changed their content before cleaning the tree", async () => {
    await writeWorkspaceFile("tracked.txt", "dirty before prompt\n");

    const beforeState = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );

    await writeWorkspaceFile("tracked.txt", "after prompt edit\n");
    runGit(["add", "tracked.txt"]);
    runGit(["commit", "-m", "Commit updated workspace change"]);

    const afterState = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    const changes = await snapshotService.computeSnapshotChanges(
      beforeState,
      afterState,
      workspaceRoot
    );

    assert.strictEqual(afterState.segments[0].files.size, 0);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0]?.path, "tracked.txt");
    assert.strictEqual(changes[0]?.changeType, "modified");
    assert.strictEqual(changes[0]?.beforeContent, "dirty before prompt\n");
    assert.ok((changes[0]?.structuredPatch?.length ?? 0) > 0);
  });

  test("detects edits and new files that were committed mid-prompt leaving a clean tree on both sides", async () => {
    const beforeState = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    assert.strictEqual(beforeState.segments[0].files.size, 0);

    await writeWorkspaceFile("tracked.txt", "edited by prompt\n");
    await writeWorkspaceFile("created.txt", "brand new file\n");
    await fs.rm(path.join(workspaceRoot, "tracked.txt")).catch(() => {});
    await writeWorkspaceFile("tracked.txt", "edited by prompt\n");
    runGit(["add", "-A"]);
    runGit(["commit", "-m", "Prompt commits its own work"]);

    const afterState = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    assert.strictEqual(afterState.segments[0].files.size, 0);
    assert.notStrictEqual(
      beforeState.git?.headCommit,
      afterState.git?.headCommit
    );

    const changes = await snapshotService.computeSnapshotChanges(
      beforeState,
      afterState,
      workspaceRoot
    );

    const byPath = new Map(changes.map((change) => [change.path, change]));

    const trackedChange = byPath.get("tracked.txt");
    assert.strictEqual(trackedChange?.changeType, "modified");
    assert.strictEqual(trackedChange?.beforeContent, "base\n");
    assert.ok((trackedChange?.structuredPatch?.length ?? 0) > 0);

    const createdChange = byPath.get("created.txt");
    assert.strictEqual(createdChange?.changeType, "created");
    assert.ok(createdChange?.afterHash);
  });

  test("detects files deleted and committed mid-prompt leaving a clean tree on both sides", async () => {
    const beforeState = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );

    await fs.rm(path.join(workspaceRoot, "tracked.txt"));
    runGit(["add", "-A"]);
    runGit(["commit", "-m", "Prompt deletes and commits a file"]);

    const afterState = await snapshotService.captureWorkspaceState(
      workspaceRoot,
      SNAPSHOT_STRATEGIES.GIT
    );
    assert.strictEqual(afterState.segments[0].files.size, 0);

    const changes = await snapshotService.computeSnapshotChanges(
      beforeState,
      afterState,
      workspaceRoot
    );

    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0]?.path, "tracked.txt");
    assert.strictEqual(changes[0]?.changeType, "deleted");
    assert.strictEqual(changes[0]?.contentToRestore, "base\n");
  });

  test("undo preserves FILE_WRITE, FILE_EDIT, and FILE_DELETE semantics", async () => {
    await writeWorkspaceFile("created.txt", "new file\n");
    await writeWorkspaceFile("tracked.txt", "edited\n");
    await fs.rm(path.join(workspaceRoot, "deleted.txt"), { force: true });

    const result = await snapshotService.undoFiles(
      [
        {
          // FILE_WRITE: undo removes the file created by the harness.
          path: "created.txt",
          action: UNDO_FILE_ACTIONS.DELETE,
        },
        {
          // FILE_EDIT: undo applies the reverse of the forward diff.
          path: "tracked.txt",
          action: UNDO_FILE_ACTIONS.REVERSE_PATCH,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ["-base", "+edited"],
            },
          ],
        },
        {
          // FILE_DELETE: undo restores the workspace snapshot content.
          path: "deleted.txt",
          action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
          contentToRestore: "deleted before\n",
        },
      ],
      workspaceRoot
    );

    assert.deepStrictEqual(result.restoredFiles, [
      "created.txt",
      "tracked.txt",
      "deleted.txt",
    ]);
    assert.deepStrictEqual(result.failedFiles, []);
    await assert.rejects(() =>
      fs.access(path.join(workspaceRoot, "created.txt"))
    );
    assert.strictEqual(
      await fs.readFile(path.join(workspaceRoot, "tracked.txt"), "utf8"),
      "base\n"
    );
    assert.strictEqual(
      await fs.readFile(path.join(workspaceRoot, "deleted.txt"), "utf8"),
      "deleted before\n"
    );
  });
});

// ── Multi-root (multiple repos) ─────────────────────────────────────────────

suite("WorkspaceSnapshotService — multi-root", function () {
  const tempDirs: string[] = [];
  let snapshotService: WorkspaceSnapshotService;

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
  }

  async function createRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cy-snap-mr-"));
    tempDirs.push(dir);
    git(dir, "init");
    git(dir, "config", "user.name", "ctrlyoke Tests");
    git(dir, "config", "user.email", "ctrlyoke-tests@example.com");
    await fs.writeFile(path.join(dir, "tracked.txt"), "base\n", "utf8");
    git(dir, "add", "tracked.txt");
    git(dir, "commit", "-m", "init");
    return dir;
  }

  setup(() => {
    snapshotService = new WorkspaceSnapshotService();
  });

  teardown(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  test("captures a segment per root and prefixes changed paths by root name", async () => {
    const rootA = await createRepo();
    const rootB = await createRepo();
    const namedRoots = [
      { name: "alpha", fsPath: rootA },
      { name: "beta", fsPath: rootB },
    ];

    const before = await snapshotService.captureWorkspaceState(
      rootA,
      SNAPSHOT_STRATEGIES.GIT,
      namedRoots
    );
    assert.strictEqual(before.segments.length, 2);

    // The AI edits a file in the primary root and creates one in the secondary.
    await fs.writeFile(path.join(rootA, "tracked.txt"), "edited\n", "utf8");
    await fs.writeFile(path.join(rootB, "new.txt"), "fresh\n", "utf8");

    const after = await snapshotService.captureWorkspaceState(
      rootA,
      SNAPSHOT_STRATEGIES.GIT,
      namedRoots
    );
    const changes = await snapshotService.computeSnapshotChanges(
      before,
      after,
      rootA
    );

    const byPath = new Map(changes.map((c) => [c.path, c]));
    const edited = byPath.get("alpha/tracked.txt");
    assert.strictEqual(edited?.changeType, "modified");
    assert.strictEqual(edited?.repo, "alpha");

    const created = byPath.get("beta/new.txt");
    assert.strictEqual(created?.changeType, "created");
    assert.strictEqual(created?.repo, "beta");
  });

  test("snapshotRepoInfos returns per-repo info in multi-root, undefined in single-root", async () => {
    const rootA = await createRepo();
    const rootB = await createRepo();

    const multi = await snapshotService.captureWorkspaceState(
      rootA,
      SNAPSHOT_STRATEGIES.GIT,
      [
        { name: "alpha", fsPath: rootA },
        { name: "beta", fsPath: rootB },
      ]
    );
    const repos = snapshotService.snapshotRepoInfos(multi);
    assert.ok(repos);
    assert.deepStrictEqual(repos.map((r) => r.prefix).sort(), [
      "alpha",
      "beta",
    ]);

    const single = await snapshotService.captureWorkspaceState(
      rootA,
      SNAPSHOT_STRATEGIES.GIT
    );
    assert.strictEqual(snapshotService.snapshotRepoInfos(single), undefined);
  });

  test("undo resolves a folder-name-prefixed path to the correct secondary root", async () => {
    const rootA = await createRepo();
    const rootB = await createRepo();
    const namedRoots = [
      { name: "alpha", fsPath: rootA },
      { name: "beta", fsPath: rootB },
    ];

    // A file the AI created in the secondary root — undo should delete it there.
    await fs.writeFile(path.join(rootB, "created.txt"), "ai output\n", "utf8");

    const result = await snapshotService.undoFiles(
      [{ path: "beta/created.txt", action: UNDO_FILE_ACTIONS.DELETE }],
      rootA,
      namedRoots
    );

    assert.deepStrictEqual(result.restoredFiles, ["beta/created.txt"]);
    assert.strictEqual(result.failedFiles.length, 0);
    await assert.rejects(() => fs.access(path.join(rootB, "created.txt")));
  });

  test("undo rejects a prefixed path that escapes every trusted root", async () => {
    const rootA = await createRepo();
    const rootB = await createRepo();
    const namedRoots = [
      { name: "alpha", fsPath: rootA },
      { name: "beta", fsPath: rootB },
    ];

    const result = await snapshotService.undoFiles(
      [
        {
          path: "beta/../../escape.txt",
          action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
          contentToRestore: "x",
        },
      ],
      rootA,
      namedRoots
    );

    assert.strictEqual(result.restoredFiles.length, 0);
    assert.strictEqual(result.failedFiles.length, 1);
    assert.match(result.failedFiles[0]?.error ?? "", /traversal/i);
  });

  test("discovers and persists the execution checkout for remapped named roots", async () => {
    const sourceRoot = await createRepo();
    await fs.mkdir(path.join(sourceRoot, "packages", "app"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(sourceRoot, "packages", "app", "tracked.txt"),
      "base\n",
      "utf8"
    );
    git(sourceRoot, "add", "packages/app/tracked.txt");
    git(sourceRoot, "commit", "-m", "add app");

    const executionRoot = path.join(
      path.dirname(sourceRoot),
      `${path.basename(sourceRoot)}-worktree`
    );
    tempDirs.unshift(executionRoot);
    git(sourceRoot, "worktree", "add", "--detach", executionRoot);

    const docsRoot = path.join(sourceRoot, "packages", "docs");
    await fs.mkdir(docsRoot, { recursive: true });
    await fs.writeFile(path.join(docsRoot, "tracked.txt"), "docs\n", "utf8");
    git(sourceRoot, "add", "packages/docs/tracked.txt");
    git(sourceRoot, "commit", "-m", "add docs");

    // Both named roots are inside the same source repository. The roots passed
    // here are execution-side paths, so discovery and persisted repo metadata
    // must identify the linked checkout rather than sourceRoot.
    const namedRoots = [
      { name: "app", fsPath: path.join(executionRoot, "packages", "app") },
      { name: "docs", fsPath: path.join(executionRoot, "packages", "docs") },
    ];
    const state = await snapshotService.captureWorkspaceState(
      executionRoot,
      SNAPSHOT_STRATEGIES.GIT,
      namedRoots
    );

    await fs.writeFile(
      path.join(executionRoot, "packages", "app", "tracked.txt"),
      "execution edit\n",
      "utf8"
    );
    const after = await snapshotService.captureWorkspaceState(
      executionRoot,
      SNAPSHOT_STRATEGIES.GIT,
      namedRoots
    );
    const changes = await snapshotService.computeSnapshotChanges(
      state,
      after,
      executionRoot
    );
    const repos = snapshotService.snapshotRepoInfos(after);

    assert.ok(repos);
    assert.ok(repos.every((repo) => repo.root === executionRoot));
    const appChange = changes.find(
      (change) => change.path === "app/tracked.txt"
    );
    assert.ok(appChange);
    assert.strictEqual(appChange.repo, "app");
  });
});
