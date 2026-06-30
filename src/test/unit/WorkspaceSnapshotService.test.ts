import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, test, setup, teardown } from "mocha";
import { WorkspaceSnapshotService } from "../../utils/WorkspaceSnapshotService";
import { SNAPSHOT_STRATEGIES } from "../../types/DashboardConstants";

suite("WorkspaceSnapshotService", () => {
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
    runGit(["add", "tracked.txt"]);
    runGit(["commit", "-m", "Initial commit"]);
  }

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fp-snapshot-"));
    snapshotService = new WorkspaceSnapshotService();
    await initializeRepo();
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
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

    assert.strictEqual(afterState.files.size, 0);
    assert.deepStrictEqual(changes, []);
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

    assert.strictEqual(afterState.files.size, 0);
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
    assert.strictEqual(beforeState.files.size, 0);

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
    assert.strictEqual(afterState.files.size, 0);
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
    assert.strictEqual(afterState.files.size, 0);

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
});
