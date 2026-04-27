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
    runGit(["config", "user.name", "FlightPath Tests"]);
    runGit(["config", "user.email", "flightpath-tests@example.com"]);
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
});
