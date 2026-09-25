import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, teardown, test } from "mocha";
import {
  WorktreeManager,
  WorktreeSetupError,
  type WorktreeMergeOperations,
  type WorktreeSetupRunner,
} from "../../core/orchestration/WorktreeManager";
import { ExecutionRootLeaseManager } from "../../core/orchestration/ExecutionRootLeaseManager";
import { summarizeStatusError } from "../../core/orchestration/ScriptExecutionReporter";
import type { ScriptProcessResult } from "../../core/orchestration/ScriptProcessRunner";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";
import {
  WORKTREE_MANAGEMENT_ACTIONS,
  WORKTREE_SETUP_OUTCOMES,
} from "../../types/DashboardConstants";

class RecordingWorktreeSetupRunner implements WorktreeSetupRunner {
  readonly calls: Array<Parameters<WorktreeSetupRunner["run"]>[0]> = [];

  constructor(private readonly result: ScriptProcessResult) {}

  async run(
    args: Parameters<WorktreeSetupRunner["run"]>[0]
  ): Promise<ScriptProcessResult> {
    this.calls.push(args);
    return this.result;
  }
}

suite("WorktreeManager", function () {
  // Raised above the 30s harness default: every case builds real repositories
  // and worktrees, dozens of `git` spawns each. Idle, the heaviest case takes
  // ~3s; beside the Vitest pool alone it was measured at 15.6s, and a full
  // `npm test` (six extension hosts plus Vitest) pushed it past 30s.
  this.timeout(120_000);
  const temporaryDirectories: string[] = [];

  teardown(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        // These are real git repositories with worktrees attached, and Windows
        // holds transient locks on pack files as git's own processes exit —
        // `rm` then fails with EBUSY/EPERM. Retry those, and never let residual
        // cleanup of an OS temp directory fail an otherwise green run.
        fs
          .rm(directory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          })
          .catch(() => {})
      )
    );
  });

  async function makeRepository(name: string): Promise<{
    parent: string;
    repository: string;
  }> {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), `ctrlyoke-${name}-`)
    );
    temporaryDirectories.push(parent);
    const repository = path.join(parent, "repository");
    await fs.mkdir(repository);
    execFileSync("git", ["init", repository], { stdio: "ignore" });
    execFileSync("git", [
      "-C",
      repository,
      "config",
      "user.email",
      "test@example.com",
    ]);
    execFileSync("git", [
      "-C",
      repository,
      "config",
      "user.name",
      "ctrlyoke test",
    ]);
    await fs.writeFile(path.join(repository, "README.md"), "base\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "base"], {
      stdio: "ignore",
    });
    return { parent, repository };
  }

  function identity(): { workflowKey: WorkflowKey; runRef: RunRef } {
    return {
      workflowKey: "manager-test" as WorkflowKey,
      runRef: "run-1" as RunRef,
    };
  }

  function manager(
    parent: string,
    updates: string[] = [],
    mergeOperations?: Partial<WorktreeMergeOperations>
  ): WorktreeManager {
    return new WorktreeManager({
      worktreeRoot: path.join(parent, "worktrees"),
      mergeOperations,
      updateWorktreeRuntime: async (patch) => {
        updates.push(
          `${patch.lifecycleState ?? "unknown"}:${patch.dirty ?? false}`
        );
      },
    });
  }

  function localBranchExists(repository: string, branchName: string): boolean {
    try {
      execFileSync(
        "git",
        ["-C", repository, "rev-parse", "--verify", `refs/heads/${branchName}`],
        { stdio: "ignore" }
      );
      return true;
    } catch {
      return false;
    }
  }

  async function managedRecordFiles(repository: string): Promise<string[]> {
    const commonDirectory = path.resolve(
      repository,
      execFileSync("git", ["-C", repository, "rev-parse", "--git-common-dir"], {
        encoding: "utf8",
      }).trim()
    );
    try {
      return await fs.readdir(
        path.join(commonDirectory, "ctrlyoke", "managed-worktrees")
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function resolve(
    instance: WorktreeManager,
    repository: string,
    branchName: string,
    overrides: Partial<
      Parameters<WorktreeManager["resolveNamedWorktree"]>[0]
    > = {}
  ) {
    const ids = identity();
    return instance.resolveNamedWorktree({
      sourceCheckoutRoot: repository,
      branchName,
      stateRoot: repository,
      namedWorkspaceRoots: [{ name: "repository", fsPath: repository }],
      ...ids,
      ...overrides,
    });
  }

  async function ensureManaged(
    instance: WorktreeManager,
    repository: string,
    overrides: Partial<
      Parameters<WorktreeManager["ensureManagedWorktree"]>[0]
    > = {}
  ) {
    const ids = identity();
    return instance.ensureManagedWorktree({
      sourceCheckoutRoot: repository,
      stateRoot: repository,
      namedWorkspaceRoots: [{ name: "repository", fsPath: repository }],
      workflowName: "Managed Test Workflow",
      ...ids,
      ...overrides,
    });
  }

  test("discovers a branch checkout and rejects the initiating checkout", async () => {
    const { parent, repository } = await makeRepository("discover");
    const currentBranch = execFileSync(
      "git",
      ["-C", repository, "branch", "--show-current"],
      { encoding: "utf8" }
    ).trim();
    await assert.rejects(
      resolve(manager(parent), repository, currentBranch),
      /initiating source checkout/
    );

    const linked = path.join(parent, "linked");
    execFileSync(
      "git",
      ["-C", repository, "worktree", "add", "-b", "feature/discovered", linked],
      {
        stdio: "ignore",
      }
    );
    const info = await resolve(
      manager(parent),
      repository,
      "feature/discovered"
    );
    assert.strictEqual(info.origin, "discovered");
    assert.strictEqual(info.worktreePath, linked);
    await info.lease.release();
  });

  test("attaches an existing local branch", async () => {
    const first = await makeRepository("attach");
    execFileSync("git", ["-C", first.repository, "branch", "feature/existing"]);
    const attached = await resolve(
      manager(first.parent),
      first.repository,
      "feature/existing"
    );
    assert.strictEqual(attached.origin, "created");
    assert.strictEqual(
      execFileSync(
        "git",
        ["-C", attached.worktreePath, "branch", "--show-current"],
        {
          encoding: "utf8",
        }
      ).trim(),
      "feature/existing"
    );
    await attached.lease.release();
  });

  test("creates a missing branch", async () => {
    const second = await makeRepository("create");
    const created = await resolve(
      manager(second.parent),
      second.repository,
      "feature/missing",
      { base: "HEAD" }
    );
    assert.strictEqual(created.origin, "created");
    assert.strictEqual(created.dirty, false);
    assert.strictEqual(
      execFileSync(
        "git",
        ["-C", created.worktreePath, "branch", "--show-current"],
        {
          encoding: "utf8",
        }
      ).trim(),
      "feature/missing"
    );
    assert.strictEqual(
      await fs
        .stat(path.join(created.worktreePath, ".ctrlyoke", ".gitignore"))
        .then((stat) => stat.isFile()),
      true
    );
    await created.lease.release();
  });

  test("reports dirty named worktrees and persists provisioning then ready", async () => {
    const { parent, repository } = await makeRepository("dirty");
    const linked = path.join(parent, "dirty-linked");
    execFileSync(
      "git",
      ["-C", repository, "worktree", "add", "-b", "feature/dirty", linked],
      {
        stdio: "ignore",
      }
    );
    await fs.writeFile(path.join(linked, "dirty.txt"), "user change\n");
    const updates: string[] = [];
    const info = await resolve(
      manager(parent, updates),
      repository,
      "feature/dirty"
    );
    assert.strictEqual(info.dirty, true);
    assert.deepStrictEqual(
      updates.map((value) => value.split(":")[0]),
      ["provisioning", "ready"]
    );
    await info.lease.release();
  });

  test("blocks an exclusive target while a native run owns the same worktree", async () => {
    const { parent, repository } = await makeRepository("lease-conflict");
    const linked = path.join(parent, "lease-linked");
    execFileSync(
      "git",
      ["-C", repository, "worktree", "add", "-b", "feature/lease", linked],
      {
        stdio: "ignore",
      }
    );
    const ids = identity();
    const nativeLease = await ExecutionRootLeaseManager.acquire({
      mode: "shared-native",
      stateRoot: repository,
      executionRoot: linked,
      ...ids,
      runner: "vscode",
      instanceId: "native-test",
    });
    try {
      await assert.rejects(
        resolve(manager(parent), repository, "feature/lease"),
        /Execution root is in use/
      );
    } finally {
      await nativeLease.release();
    }
  });

  test("remaps monorepo roots and keeps outside state outside the worktree", async () => {
    const { parent, repository } = await makeRepository("mapping");
    const monorepoSubdirectory = path.join(repository, "packages", "app");
    await fs.mkdir(monorepoSubdirectory, { recursive: true });
    const state = path.join(parent, "workspace-state");
    await fs.mkdir(state);
    const ids = identity();
    const updates: string[] = [];
    const info = await new WorktreeManager({
      worktreeRoot: path.join(parent, "worktrees"),
      updateWorktreeRuntime: async () => {
        updates.push("updated");
      },
    }).resolveNamedWorktree({
      sourceCheckoutRoot: repository,
      branchName: "feature/mapping",
      stateRoot: monorepoSubdirectory,
      namedWorkspaceRoots: [{ name: "app", fsPath: monorepoSubdirectory }],
      ...ids,
    });
    assert.strictEqual(
      info.executionWorkspace.executionRoot,
      path.join(info.worktreePath, "packages", "app")
    );
    assert.deepStrictEqual(info.executionWorkspace.workspaceRoots, [
      path.join(info.worktreePath, "packages", "app"),
    ]);
    assert.strictEqual(
      info.executionWorkspace.namedWorkspaceRoots[0]?.fsPath,
      path.join(info.worktreePath, "packages", "app")
    );
    assert.strictEqual(
      await fs
        .stat(
          path.join(
            info.executionWorkspace.executionRoot,
            ".ctrlyoke",
            ".gitignore"
          )
        )
        .then((stat) => stat.isFile()),
      true
    );
    await info.lease.release();

    const outside = await resolve(
      manager(parent),
      repository,
      "feature/outside-state",
      {
        stateRoot: state,
        namedWorkspaceRoots: [{ name: "repository", fsPath: repository }],
      }
    );
    assert.strictEqual(outside.executionWorkspace.stateRoot, state);
    assert.strictEqual(
      outside.executionWorkspace.executionRoot,
      outside.worktreePath
    );
    assert.deepStrictEqual(outside.executionWorkspace.workspaceRoots, [
      outside.worktreePath,
    ]);
    await outside.lease.release();
  });

  test("rejects trust roots that overlap the source checkout", async () => {
    const { parent, repository } = await makeRepository("trust");
    await assert.rejects(
      resolve(manager(parent), repository, "feature/trust", {
        approvedExternalRoots: [repository],
      }),
      /overlaps the source checkout/
    );
    await assert.rejects(
      resolve(manager(parent), repository, "feature/trust-2", {
        additionalRoots: [path.dirname(repository)],
      }),
      /overlaps the source checkout/
    );
  });

  test("runs setup once for a newly created worktree", async () => {
    const { parent, repository } = await makeRepository("setup-once");
    const setup = `node -e "require('fs').writeFileSync('setup-marker.txt', process.env.CTRLYOKE_VAR_MESSAGE)"`;
    const updates: string[] = [];
    const info = await resolve(
      manager(parent, updates),
      repository,
      "feature/setup",
      {
        setup,
        vars: { message: "created" },
      }
    );
    assert.strictEqual(info.setupOutcome, "succeeded");
    assert.strictEqual(
      await fs.readFile(
        path.join(info.worktreePath, "setup-marker.txt"),
        "utf8"
      ),
      "created"
    );
    await info.lease.release();
    assert.deepStrictEqual(
      updates.filter((value) => value.startsWith("provisioning")),
      ["provisioning:false", "provisioning:false", "provisioning:false"]
    );
  });

  test("delegates setup to the injected runner with substituted variables", async () => {
    const { parent, repository } = await makeRepository("setup-runner");
    const runner = new RecordingWorktreeSetupRunner({
      success: true,
      result: "",
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const instance = new WorktreeManager({
      worktreeRoot: path.join(parent, "worktrees"),
      worktreeSetupRunner: runner,
    });

    const info = await resolve(instance, repository, "feature/setup-runner", {
      setup: "echo {{message}}",
      vars: { message: "created" },
      setupAttemptIndex: 3,
    });

    assert.strictEqual(runner.calls.length, 1);
    assert.deepStrictEqual(runner.calls[0], {
      executionRoot: info.worktreePath,
      command: "echo created",
      vars: { message: "created" },
      timeoutMs: runner.calls[0]!.timeoutMs,
      attemptIndex: 3,
    });
    assert.ok(runner.calls[0]!.timeoutMs > 0);
    await info.lease.release();
  });

  test("leaves unresolved setup variables literal and reports an advisory", async () => {
    const { parent, repository } = await makeRepository(
      "setup-unresolved-variable"
    );
    const runner = new RecordingWorktreeSetupRunner({
      success: true,
      result: "",
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const unresolved: string[][] = [];
    const instance = new WorktreeManager({
      worktreeRoot: path.join(parent, "worktrees"),
      worktreeSetupRunner: runner,
    });

    const info = await resolve(
      instance,
      repository,
      "feature/setup-unresolved-variable",
      {
        setup: "echo {{unknown}}",
        vars: { known: "value" },
        reportUnresolvedVariables: (placeholders) =>
          unresolved.push([...placeholders]),
      }
    );

    assert.deepStrictEqual(unresolved, [["{{unknown}}"]]);
    assert.strictEqual(runner.calls[0]!.command, "echo {{unknown}}");
    await info.lease.release();
  });

  test("does not report setup variables when workflow vars are absent", async () => {
    const { parent, repository } = await makeRepository(
      "setup-unresolved-variable-without-vars"
    );
    const runner = new RecordingWorktreeSetupRunner({
      success: true,
      result: "",
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const unresolved: string[][] = [];
    const instance = new WorktreeManager({
      worktreeRoot: path.join(parent, "worktrees"),
      worktreeSetupRunner: runner,
    });

    const info = await resolve(instance, repository, "feature/setup-no-vars", {
      setup: "echo {{unknown}}",
      reportUnresolvedVariables: (placeholders) =>
        unresolved.push([...placeholders]),
    });

    assert.deepStrictEqual(unresolved, []);
    assert.strictEqual(runner.calls[0]!.command, "echo {{unknown}}");
    await info.lease.release();
  });

  test("persists failed setup durably, leaves the directory, and throws", async () => {
    const { parent, repository } = await makeRepository("setup-failed");
    const updates: string[] = [];
    const instance = manager(parent, updates);
    const setup = `node -e "process.exit(7)"`;
    await assert.rejects(
      resolve(instance, repository, "feature/setup-failed", {
        setup,
      }),
      (error: unknown) => error instanceof WorktreeSetupError
    );
    const worktrees = await fs.readdir(path.join(parent, "worktrees"));
    assert.strictEqual(worktrees.length, 1);
    assert.ok(updates.some((value) => value.startsWith("blocked")));
    const worktree = (await instance.listWorktrees(repository)).find(
      (entry) => entry.branchName === "feature/setup-failed"
    );
    assert.ok(worktree);
    const record = await instance.readNamedWorktreeSetupRecord(
      repository,
      worktree!.worktreePath
    );
    assert.strictEqual(record?.setupOutcome, "failed");
  });

  test("summarizes setup errors instead of duplicating the raw output", async () => {
    const { parent, repository } = await makeRepository("setup-error-summary");
    const rawError = `\u001b[31mfirst line\u001b[0m\r\nsecond line ${"details ".repeat(40)}`;
    const runner = new RecordingWorktreeSetupRunner({
      success: false,
      result: "",
      error: rawError,
      stdout: "",
      stderr: rawError,
      exitCode: 1,
    });
    const instance = new WorktreeManager({
      worktreeRoot: path.join(parent, "worktrees"),
      worktreeSetupRunner: runner,
    });

    await assert.rejects(
      resolve(instance, repository, "feature/setup-error-summary", {
        setup: "npm ci",
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorktreeSetupError);
        const setupError = error as WorktreeSetupError;
        assert.strictEqual(
          setupError.message,
          `Worktree setup failed in ${setupError.worktreePath}: ${summarizeStatusError(rawError)}`
        );
        return true;
      }
    );
  });

  test("re-runs failed setup on the next resolve", async () => {
    const { parent, repository } = await makeRepository("setup-retry");
    const instance = manager(parent);
    await assert.rejects(
      resolve(instance, repository, "feature/retry", {
        setup: `node -e "process.exit(7)"`,
      }),
      /Worktree setup failed/
    );
    const setup = `node -e "require('fs').writeFileSync('retry-marker.txt', 'ok')"`;
    const retried = await resolve(instance, repository, "feature/retry", {
      setup,
    });
    assert.strictEqual(retried.setupOutcome, "succeeded");
    assert.strictEqual(
      await fs.readFile(
        path.join(retried.worktreePath, "retry-marker.txt"),
        "utf8"
      ),
      "ok"
    );
    await retried.lease.release();
  });

  test("does not re-run a recorded succeeded setup", async () => {
    const { parent, repository } = await makeRepository("setup-succeeded");
    const instance = manager(parent);
    const first = await resolve(instance, repository, "feature/succeeded", {
      setup: `node -e "require('fs').writeFileSync('setup-marker.txt', 'first')"`,
    });
    await first.lease.release();

    const second = await resolve(instance, repository, "feature/succeeded", {
      setup: `node -e "process.exit(13)"`,
    });
    assert.strictEqual(second.setupOutcome, "succeeded");
    assert.strictEqual(
      await fs.readFile(
        path.join(second.worktreePath, "setup-marker.txt"),
        "utf8"
      ),
      "first"
    );
    await second.lease.release();
  });

  test("re-runs setup when a removed named checkout is recreated", async () => {
    const { parent, repository } = await makeRepository("setup-recreated");
    const instance = manager(parent);
    const first = await resolve(instance, repository, "feature/recreated", {
      setup: `node -e "require('fs').writeFileSync('setup-marker.txt', 'first')"`,
    });
    await first.lease.release();

    // Named worktree paths are derived deterministically from the branch, so
    // the recreated checkout reuses the succeeded record's key.
    execFileSync("git", [
      "-C",
      repository,
      "worktree",
      "remove",
      "--force",
      first.worktreePath,
    ]);

    const recreated = await resolve(instance, repository, "feature/recreated", {
      setup: `node -e "require('fs').writeFileSync('setup-marker.txt', 'second')"`,
    });
    assert.strictEqual(recreated.worktreePath, first.worktreePath);
    assert.strictEqual(recreated.setupOutcome, "succeeded");
    assert.strictEqual(
      await fs.readFile(
        path.join(recreated.worktreePath, "setup-marker.txt"),
        "utf8"
      ),
      "second"
    );
    await recreated.lease.release();
  });

  test("re-runs setup after a crash-shaped running record", async () => {
    const { parent, repository } = await makeRepository("setup-running");
    const instance = manager(parent);
    await assert.rejects(
      resolve(instance, repository, "feature/running", {
        setup: `node -e "process.exit(7)"`,
      }),
      /Worktree setup failed/
    );
    const worktree = (await instance.listWorktrees(repository)).find(
      (entry) => entry.branchName === "feature/running"
    );
    assert.ok(worktree);
    const commonDirectory = path.resolve(
      repository,
      execFileSync("git", ["-C", repository, "rev-parse", "--git-common-dir"], {
        encoding: "utf8",
      }).trim()
    );
    const recordDirectory = path.join(
      commonDirectory,
      "ctrlyoke",
      "named-worktrees"
    );
    const [recordFile] = await fs.readdir(recordDirectory);
    const recordPath = path.join(recordDirectory, recordFile);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
      setupOutcome: string;
      updatedAt: number;
    };
    await fs.writeFile(
      recordPath,
      JSON.stringify({
        ...record,
        setupOutcome: "running",
        updatedAt: Date.now(),
      })
    );

    const resolved = await resolve(instance, repository, "feature/running", {
      setup: `node -e "require('fs').writeFileSync('running-marker.txt', 'ok')"`,
    });
    assert.strictEqual(resolved.setupOutcome, "succeeded");
    assert.strictEqual(
      await fs.readFile(
        path.join(resolved.worktreePath, "running-marker.txt"),
        "utf8"
      ),
      "ok"
    );
    await resolved.lease.release();
  });

  test("creates an atomic ownership record and re-enters idempotently", async () => {
    const { parent, repository } = await makeRepository("managed-create");
    const instance = manager(parent);
    const first = await ensureManaged(instance, repository);
    const record = await instance.readManagedWorktreeRecord(
      repository,
      first.branchName
    );
    assert.ok(record);
    assert.strictEqual(record?.schemaVersion, 1);
    assert.strictEqual(record?.baseCommit, first.baseCommit);
    assert.strictEqual(record?.lastVerifiedBranchTip, first.baseCommit);
    assert.strictEqual(record?.directoryState, "present");
    assert.strictEqual(record?.branchState, "present");
    assert.ok(record?.worktreePath.endsWith(path.basename(first.worktreePath)));
    await first.lease.release();

    const second = await ensureManaged(instance, repository);
    assert.strictEqual(second.branchName, first.branchName);
    assert.strictEqual(second.worktreePath, first.worktreePath);
    assert.strictEqual(second.origin, "recovered");
    await second.lease.release();
  });

  test("activation discovery reports live leases and prunable entries without pruning", async () => {
    const { parent, repository } = await makeRepository("activation-discovery");
    const instance = manager(parent);
    const managed = await ensureManaged(instance, repository);

    const userWorktreePath = path.join(parent, "user-prunable");
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "worktree",
        "add",
        "-b",
        "user/prunable",
        userWorktreePath,
      ],
      { stdio: "ignore" }
    );
    await fs.rm(userWorktreePath, { recursive: true, force: true });

    const before = execFileSync(
      "git",
      ["-C", repository, "worktree", "list", "--porcelain", "-z"],
      { encoding: "utf8" }
    );
    const report = await instance.discoverActivationState({
      sourceCheckoutRoot: repository,
    });
    const managedEntry = report.worktrees.find(
      (entry) => entry.branchName === managed.branchName
    );
    const prunableEntry = report.worktrees.find(
      (entry) => entry.branchName === "user/prunable"
    );

    assert.strictEqual(managedEntry?.inUse, true);
    assert.strictEqual(
      managedEntry?.leaseOwners[0]?.lease.workflowKey,
      identity().workflowKey
    );
    assert.strictEqual(
      managedEntry?.leaseOwners[0]?.lease.runRef,
      identity().runRef
    );
    assert.strictEqual(prunableEntry?.stale, true);
    const after = execFileSync(
      "git",
      ["-C", repository, "worktree", "list", "--porcelain", "-z"],
      { encoding: "utf8" }
    );
    assert.strictEqual(
      after,
      before,
      "read-only discovery must not prune Git entries"
    );

    await managed.lease.release();
  });

  test("activation discovery surfaces ownership when opened inside a managed worktree", async () => {
    const { parent, repository } = await makeRepository(
      "activation-current-worktree"
    );
    const managed = await ensureManaged(manager(parent), repository);

    const report = await manager(parent).discoverActivationState({
      sourceCheckoutRoot: managed.worktreePath,
    });

    assert.deepStrictEqual(report.currentManagedWorktree, {
      branchName: managed.branchName,
      worktreePath: managed.worktreePath,
      sourceCheckoutRoot: repository,
    });
    await managed.lease.release();
  });

  test("seeds .ctrlyoke/.gitignore in a newly created managed worktree", async () => {
    const { parent, repository } = await makeRepository("managed-gitignore");
    const info = await ensureManaged(manager(parent), repository);

    assert.strictEqual(
      await fs
        .stat(path.join(info.worktreePath, ".ctrlyoke", ".gitignore"))
        .then((stat) => stat.isFile()),
      true
    );
    await info.lease.release();
  });

  test("seeds .ctrlyoke/.gitignore at a nested managed execution root", async () => {
    const { parent, repository } = await makeRepository(
      "managed-nested-gitignore"
    );
    const stateRoot = path.join(repository, "packages", "app");
    await fs.mkdir(stateRoot, { recursive: true });
    const info = await ensureManaged(manager(parent), repository, {
      stateRoot,
      namedWorkspaceRoots: [{ name: "app", fsPath: stateRoot }],
    });

    assert.strictEqual(
      await fs
        .stat(
          path.join(
            info.executionWorkspace.executionRoot,
            ".ctrlyoke",
            ".gitignore"
          )
        )
        .then((stat) => stat.isFile()),
      true
    );
    await info.lease.release();
  });

  test("runs setup before returning a newly created managed worktree", async () => {
    const { parent, repository } = await makeRepository("managed-setup");
    const setup = `node -e "require('fs').writeFileSync('managed-setup-marker.txt', 'created')"`;
    const info = await ensureManaged(manager(parent), repository, { setup });

    assert.strictEqual(info.setupOutcome, "succeeded");
    assert.strictEqual(
      await fs.readFile(
        path.join(info.worktreePath, "managed-setup-marker.txt"),
        "utf8"
      ),
      "created"
    );
    await info.lease.release();
  });

  test("reruns setup when a managed append recreates a removed directory", async () => {
    const { parent, repository } = await makeRepository(
      "managed-setup-recreate"
    );
    const instance = manager(parent);
    const setup = `node -e "require('fs').appendFileSync('managed-setup-marker.txt', 'setup\\n')"`;

    const first = await ensureManaged(instance, repository, { setup });
    await instance.completeManagedRun(first);
    const recordAfterRemoval = await instance.readManagedWorktreeRecord(
      repository,
      first.branchName
    );
    assert.strictEqual(recordAfterRemoval?.directoryState, "removed");

    const append = await ensureManaged(instance, repository, { setup });
    assert.strictEqual(append.origin, "recovered");
    assert.strictEqual(append.setupOutcome, "succeeded");
    assert.strictEqual(
      (
        await fs.readFile(
          path.join(append.worktreePath, "managed-setup-marker.txt"),
          "utf8"
        )
      ).replaceAll("\r\n", "\n"),
      "setup\nsetup\n"
    );
    await append.lease.release();
  });

  test("does not rerun setup when a managed append keeps its directory", async () => {
    const { parent, repository } = await makeRepository("managed-setup-keep");
    const instance = manager(parent);
    const setup = `node -e "require('fs').appendFileSync('managed-setup-marker.txt', 'setup\\n')"`;

    const first = await ensureManaged(instance, repository, { setup });
    await instance.completeManagedRun(first, { keep: true });

    const append = await ensureManaged(instance, repository, { setup });
    assert.strictEqual(append.origin, "recovered");
    assert.strictEqual(append.setupOutcome, undefined);
    assert.strictEqual(
      await fs.readFile(
        path.join(append.worktreePath, "managed-setup-marker.txt"),
        "utf8"
      ),
      "setup\n"
    );
    await append.lease.release();
  });

  test("persists failed setup and throws when a managed append recreate fails", async () => {
    const { parent, repository } = await makeRepository(
      "managed-setup-recreate-failed"
    );
    const runtimePatches: Array<{
      lifecycleState?: string;
      setupOutcome?: string;
    }> = [];
    const instance = new WorktreeManager({
      worktreeRoot: path.join(parent, "worktrees"),
      updateWorktreeRuntime: async (patch) => {
        runtimePatches.push(patch);
      },
    });

    const first = await ensureManaged(instance, repository, {
      setup: `node -e "require('fs').writeFileSync('managed-setup-marker.txt', 'setup')"`,
    });
    await instance.completeManagedRun(first);

    await assert.rejects(
      ensureManaged(instance, repository, {
        setup: `node -e "process.exit(7)"`,
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorktreeSetupError);
        return true;
      }
    );
    assert.ok(
      runtimePatches.some(
        (patch) =>
          patch.lifecycleState === "blocked" &&
          patch.setupOutcome === WORKTREE_SETUP_OUTCOMES.FAILED
      )
    );
  });

  test("reclaims a blocked managed setup attempt on the next managed run", async () => {
    const { parent, repository } = await makeRepository(
      "managed-setup-reclaim"
    );
    const instance = manager(parent);
    await assert.rejects(
      ensureManaged(instance, repository, {
        runRef: "run-1" as RunRef,
        setup: `node -e "process.exit(7)"`,
      }),
      /Worktree setup failed/
    );

    const blocked = (await instance.listWorktrees(repository)).find(
      (entry) => entry.worktreePath !== repository
    );
    assert.ok(blocked?.branchName);

    const retried = await ensureManaged(instance, repository, {
      runRef: "run-2" as RunRef,
      setup: `node -e "require('fs').writeFileSync('retry-marker.txt', 'ok')"`,
    });
    assert.strictEqual(
      (await instance.listWorktrees(repository)).some(
        (entry) => entry.branchName === blocked!.branchName
      ),
      false
    );
    assert.strictEqual(
      localBranchExists(repository, blocked!.branchName!),
      false
    );
    assert.strictEqual(
      await instance.readManagedWorktreeRecord(
        repository,
        blocked!.branchName!
      ),
      undefined
    );
    await retried.lease.release();
  });

  test("keeps a blocked managed branch whose watermark carries landed commits", async () => {
    const { parent, repository } = await makeRepository(
      "managed-setup-reclaim-landed"
    );
    const instance = manager(parent);
    await assert.rejects(
      ensureManaged(instance, repository, {
        runRef: "run-1" as RunRef,
        setup: `node -e "process.exit(7)"`,
      }),
      /Worktree setup failed/
    );
    const blocked = (await instance.listWorktrees(repository)).find(
      (entry) => entry.worktreePath !== repository
    );
    assert.ok(blocked?.branchName);
    await fs.writeFile(
      path.join(blocked!.worktreePath, "landed.txt"),
      "landed\n"
    );
    execFileSync("git", ["-C", blocked!.worktreePath, "add", "landed.txt"]);
    execFileSync(
      "git",
      ["-C", blocked!.worktreePath, "commit", "-m", "landed"],
      { stdio: "ignore" }
    );
    const landedTip = execFileSync(
      "git",
      ["-C", blocked!.worktreePath, "rev-parse", "HEAD"],
      { encoding: "utf8" }
    ).trim();
    await instance.markManagedBranchTipVerified(
      repository,
      blocked!.branchName!,
      landedTip
    );

    const retried = await ensureManaged(instance, repository, {
      runRef: "run-2" as RunRef,
    });
    assert.strictEqual(
      localBranchExists(repository, blocked!.branchName!),
      true
    );
    const retainedRecord = await instance.readManagedWorktreeRecord(
      repository,
      blocked!.branchName!
    );
    assert.strictEqual(retainedRecord?.directoryState, "removed");
    assert.strictEqual(retainedRecord?.branchState, "present");
    await retried.lease.release();
  });

  test("leaves a blocked managed attempt alone while its worktree has a live lease", async () => {
    const { parent, repository } = await makeRepository(
      "managed-setup-reclaim-lease"
    );
    const instance = manager(parent);
    await assert.rejects(
      ensureManaged(instance, repository, {
        runRef: "run-1" as RunRef,
        setup: `node -e "process.exit(7)"`,
      }),
      /Worktree setup failed/
    );
    const blocked = (await instance.listWorktrees(repository)).find(
      (entry) => entry.worktreePath !== repository
    );
    assert.ok(blocked?.branchName);
    const liveLease = await ExecutionRootLeaseManager.acquire({
      mode: "exclusive-worktree",
      stateRoot: repository,
      executionRoot: blocked!.worktreePath,
      workflowKey: "live-blocked" as WorkflowKey,
      runRef: "run-live" as RunRef,
      runner: "vscode",
      instanceId: "live-blocked-instance",
    });
    try {
      const retried = await ensureManaged(instance, repository, {
        runRef: "run-2" as RunRef,
      });
      assert.strictEqual(
        (await instance.listWorktrees(repository)).some(
          (entry) => entry.branchName === blocked!.branchName
        ),
        true
      );
      assert.strictEqual(
        localBranchExists(repository, blocked!.branchName!),
        true
      );
      assert.ok(
        await instance.readManagedWorktreeRecord(
          repository,
          blocked!.branchName!
        )
      );
      await retried.lease.release();
    } finally {
      await liveLease.release();
    }
  });

  test("does not accumulate ownership records across repeated failed managed attempts", async () => {
    const { parent, repository } = await makeRepository(
      "managed-setup-reclaim-repeat"
    );
    const instance = manager(parent);
    for (const runNumber of [1, 2, 3]) {
      await assert.rejects(
        ensureManaged(instance, repository, {
          runRef: `run-${runNumber}` as RunRef,
          setup: `node -e "process.exit(7)"`,
        }),
        /Worktree setup failed/
      );
      assert.strictEqual((await managedRecordFiles(repository)).length, 1);
    }
  });

  test("reconciles missing managed directories as no-changes, landed, or orphaned", async () => {
    const noChanges = await makeRepository("managed-no-changes");
    const noChangesManager = manager(noChanges.parent);
    const noChangesInfo = await ensureManaged(
      noChangesManager,
      noChanges.repository
    );
    await noChangesInfo.lease.release();
    execFileSync(
      "git",
      [
        "-C",
        noChanges.repository,
        "worktree",
        "remove",
        "--force",
        "--",
        noChangesInfo.worktreePath,
      ],
      { stdio: "ignore" }
    );
    assert.strictEqual(
      await noChangesManager.recoverManagedWorktree({
        sourceCheckoutRoot: noChanges.repository,
        branchName: noChangesInfo.branchName,
      }),
      undefined
    );
    assert.strictEqual(
      (
        await noChangesManager.readManagedWorktreeRecord(
          noChanges.repository,
          noChangesInfo.branchName
        )
      )?.recoveryOutcome,
      "no-changes"
    );

    const landed = await makeRepository("managed-landed");
    const landedManager = manager(landed.parent);
    const landedInfo = await ensureManaged(landedManager, landed.repository);
    await fs.writeFile(
      path.join(landedInfo.worktreePath, "landed.txt"),
      "landed\n"
    );
    execFileSync("git", ["-C", landedInfo.worktreePath, "add", "landed.txt"]);
    execFileSync(
      "git",
      ["-C", landedInfo.worktreePath, "commit", "-m", "landed"],
      { stdio: "ignore" }
    );
    const landedTip = execFileSync(
      "git",
      ["-C", landedInfo.worktreePath, "rev-parse", "HEAD"],
      { encoding: "utf8" }
    ).trim();
    await landedManager.markManagedBranchTipVerified(
      landed.repository,
      landedInfo.branchName,
      landedTip
    );
    await landedInfo.lease.release();
    execFileSync(
      "git",
      [
        "-C",
        landed.repository,
        "worktree",
        "remove",
        "--force",
        "--",
        landedInfo.worktreePath,
      ],
      { stdio: "ignore" }
    );
    await landedManager.recoverManagedWorktree({
      sourceCheckoutRoot: landed.repository,
      branchName: landedInfo.branchName,
    });
    assert.strictEqual(
      (
        await landedManager.readManagedWorktreeRecord(
          landed.repository,
          landedInfo.branchName
        )
      )?.recoveryOutcome,
      "landed"
    );

    const orphaned = await makeRepository("managed-orphaned");
    const orphanedManager = manager(orphaned.parent);
    const orphanedInfo = await ensureManaged(
      orphanedManager,
      orphaned.repository
    );
    await fs.writeFile(
      path.join(orphanedInfo.worktreePath, "orphaned.txt"),
      "orphaned\n"
    );
    execFileSync("git", [
      "-C",
      orphanedInfo.worktreePath,
      "add",
      "orphaned.txt",
    ]);
    execFileSync(
      "git",
      ["-C", orphanedInfo.worktreePath, "commit", "-m", "orphaned"],
      { stdio: "ignore" }
    );
    await orphanedInfo.lease.release();
    execFileSync(
      "git",
      [
        "-C",
        orphaned.repository,
        "worktree",
        "remove",
        "--force",
        "--",
        orphanedInfo.worktreePath,
      ],
      { stdio: "ignore" }
    );
    await orphanedManager.recoverManagedWorktree({
      sourceCheckoutRoot: orphaned.repository,
      branchName: orphanedInfo.branchName,
    });
    assert.strictEqual(
      (
        await orphanedManager.readManagedWorktreeRecord(
          orphaned.repository,
          orphanedInfo.branchName
        )
      )?.recoveryOutcome,
      "orphaned"
    );
  });

  test("auto-commits managed changes, records the landing, and removes the worktree", async () => {
    const { parent, repository } = await makeRepository("managed-complete");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await fs.writeFile(
      path.join(info.worktreePath, "landed-by-ctrlyoke.txt"),
      "landed\n"
    );

    const result = await instance.completeManagedRun(info);

    assert.strictEqual(result.landingOutcome, "landed");
    assert.strictEqual(result.directoryOutcome, "removed");
    assert.strictEqual(result.branchState, "present");
    assert.strictEqual(result.branchName, info.branchName);
    assert.strictEqual(result.autoCommitted, true);
    assert.strictEqual(
      (await instance.readManagedWorktreeRecord(repository, info.branchName))
        ?.directoryState,
      "removed"
    );
    assert.strictEqual(
      execFileSync(
        "git",
        [
          "-C",
          repository,
          "show",
          "--format=%s",
          "--no-patch",
          info.branchName,
        ],
        {
          encoding: "utf8",
        }
      ).trim(),
      'chore(ctrlyoke): auto-commit changes for "Managed Test Workflow"'
    );
  });

  test("lands copied runtime artifacts without treating them as blocked paths", async () => {
    const { parent, repository } = await makeRepository("managed-runtime-copy");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    const copiedRuntimePath = path.join(
      info.worktreePath,
      ".ctrlyoke",
      "logs",
      "source.log"
    );
    await fs.mkdir(path.dirname(copiedRuntimePath), { recursive: true });
    await fs.writeFile(copiedRuntimePath, "source runtime\n");
    await fs.writeFile(path.join(info.worktreePath, "landed.txt"), "landed\n");

    const result = await instance.completeManagedRun(info, { keep: true });

    assert.strictEqual(result.landingOutcome, "landed");
    assert.strictEqual(result.directoryOutcome, "kept");
    assert.strictEqual(
      execFileSync("git", ["-C", info.worktreePath, "status", "--porcelain"], {
        encoding: "utf8",
      }).trim(),
      ""
    );
  });

  test("settles a no-change append after a landed turn without deleting its branch", async () => {
    const { parent, repository } = await makeRepository(
      "managed-no-change-append"
    );
    const instance = manager(parent);
    const firstInfo = await ensureManaged(instance, repository);
    await fs.writeFile(
      path.join(firstInfo.worktreePath, "first-turn.txt"),
      "first\n"
    );

    const firstResult = await instance.completeManagedRun(firstInfo, {
      keep: true,
    });
    assert.strictEqual(firstResult.landingOutcome, "landed");

    const appendInfo = await ensureManaged(instance, repository);
    const appendResult = await instance.completeManagedRun(appendInfo);

    assert.strictEqual(appendResult.landingOutcome, "no-changes");
    assert.strictEqual(appendResult.directoryOutcome, "removed");
    assert.strictEqual(appendResult.branchState, "present");
    assert.strictEqual(
      (
        await instance.readManagedWorktreeRecord(
          repository,
          appendInfo.branchName
        )
      )?.finalBranchTip,
      execFileSync(
        "git",
        ["-C", repository, "rev-parse", appendInfo.branchName],
        { encoding: "utf8" }
      ).trim()
    );
  });

  test("counts only the files changed by a landed append", async () => {
    const { parent, repository } = await makeRepository(
      "managed-landed-append-count"
    );
    const instance = manager(parent);
    const firstInfo = await ensureManaged(instance, repository);
    await fs.writeFile(
      path.join(firstInfo.worktreePath, "first-turn.txt"),
      "first\n"
    );
    const firstResult = await instance.completeManagedRun(firstInfo, {
      keep: true,
    });
    assert.strictEqual(firstResult.landingOutcome, "landed");

    const appendInfo = await ensureManaged(instance, repository);
    await fs.writeFile(
      path.join(appendInfo.worktreePath, "second-turn.txt"),
      "second\n"
    );
    const appendResult = await instance.completeManagedRun(appendInfo, {
      keep: true,
    });

    assert.strictEqual(appendResult.landingOutcome, "landed");
    assert.strictEqual(appendResult.changedFileCount, 1);
  });

  test("blocks merge when the source checkout changed branches", async () => {
    const { parent, repository } = await makeRepository("merge-target-branch");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await fs.writeFile(
      path.join(info.worktreePath, "managed.txt"),
      "managed\n"
    );
    execFileSync("git", ["-C", repository, "checkout", "-b", "other"], {
      stdio: "ignore",
    });

    const result = await instance.completeManagedRun(info, { merge: true });

    assert.strictEqual(result.landingOutcome, "landed");
    assert.strictEqual(result.mergeOutcome, "blocked");
    assert.match(result.message ?? "", /expected/);
    assert.strictEqual(result.branchState, "present");
  });

  test("blocks merge when the source checkout is dirty without copying it", async () => {
    const { parent, repository } = await makeRepository("merge-dirty-source");
    await fs.writeFile(path.join(repository, "source-only.txt"), "source\n");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    assert.strictEqual(info.sourceCheckoutDirty, true);
    await fs.writeFile(
      path.join(info.worktreePath, "managed.txt"),
      "managed\n"
    );

    const result = await instance.completeManagedRun(info, { merge: true });

    assert.strictEqual(result.landingOutcome, "landed");
    assert.strictEqual(result.mergeOutcome, "blocked");
    assert.match(result.message ?? "", /working tree or index is dirty/);
    assert.strictEqual(
      await fs.readFile(path.join(repository, "source-only.txt"), "utf8"),
      "source\n"
    );
  });

  test("fast-forwards the captured source branch", async () => {
    const { parent, repository } = await makeRepository("merge-fast-forward");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await fs.writeFile(
      path.join(info.worktreePath, "managed.txt"),
      "managed\n"
    );

    const result = await instance.completeManagedRun(info, { merge: true });

    assert.strictEqual(result.mergeOutcome, "fast-forward");
    assert.strictEqual(
      (
        await fs.readFile(path.join(repository, "managed.txt"), "utf8")
      ).replaceAll("\r\n", "\n"),
      "managed\n"
    );
  });

  test("creates a merge commit when the captured source branch diverged", async () => {
    const { parent, repository } = await makeRepository("merge-commit");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await fs.writeFile(
      path.join(info.worktreePath, "managed.txt"),
      "managed\n"
    );
    await fs.writeFile(path.join(repository, "source.txt"), "source\n");
    execFileSync("git", ["-C", repository, "add", "source.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "source change"], {
      stdio: "ignore",
    });

    const result = await instance.completeManagedRun(info, { merge: true });

    assert.strictEqual(result.mergeOutcome, "merge-commit");
    assert.strictEqual(
      execFileSync(
        "git",
        ["-C", repository, "show", "-s", "--format=%P", "HEAD"],
        {
          encoding: "utf8",
        }
      )
        .trim()
        .split(/\s+/).length,
      2
    );
  });

  test("captures conflict paths before aborting and preserves the managed branch", async () => {
    const { parent, repository } = await makeRepository("merge-conflict");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await fs.writeFile(path.join(info.worktreePath, "README.md"), "managed\n");
    await fs.writeFile(path.join(repository, "README.md"), "source\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "source conflict"], {
      stdio: "ignore",
    });

    const result = await instance.completeManagedRun(info, { merge: true });

    assert.strictEqual(result.mergeOutcome, "conflict");
    assert.deepStrictEqual(result.conflictFiles, ["README.md"]);
    assert.strictEqual(
      execFileSync("git", ["-C", repository, "status", "--porcelain"], {
        encoding: "utf8",
      }).trim(),
      ""
    );
    assert.strictEqual(
      execFileSync("git", ["-C", repository, "rev-parse", "--verify", "HEAD"], {
        encoding: "utf8",
      }).trim().length,
      40
    );
    assert.strictEqual(
      await instance.isManagedBranchOwned(repository, info.branchName),
      true
    );
  });

  test("reports abort-failed distinctly when conflict recovery cannot abort", async () => {
    const { parent, repository } = await makeRepository("merge-abort-failed");
    const instance = manager(parent, [], {
      abort: async () => {
        throw new Error("simulated abort failure");
      },
    });
    const info = await ensureManaged(instance, repository);
    await fs.writeFile(path.join(info.worktreePath, "README.md"), "managed\n");
    await fs.writeFile(path.join(repository, "README.md"), "source\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "source conflict"], {
      stdio: "ignore",
    });

    const result = await instance.completeManagedRun(info, { merge: true });

    assert.strictEqual(result.mergeOutcome, "abort-failed");
    assert.deepStrictEqual(result.conflictFiles, ["README.md"]);
    assert.match(result.message ?? "", /simulated abort failure/);
  });

  test("fails merge immediately with source lease owner details", async () => {
    const { parent, repository } = await makeRepository("merge-lease-conflict");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await fs.writeFile(
      path.join(info.worktreePath, "managed.txt"),
      "managed\n"
    );
    const sourceLease = await ExecutionRootLeaseManager.acquire({
      mode: "exclusive-worktree",
      stateRoot: repository,
      executionRoot: repository,
      workflowKey: "source-owner" as WorkflowKey,
      runRef: "source-run" as RunRef,
      runner: "vscode",
      instanceId: "source-owner-instance",
    });

    try {
      const result = await instance.completeManagedRun(info, { merge: true });
      assert.strictEqual(result.mergeOutcome, "blocked");
      assert.match(result.message ?? "", /source-owner/);
      assert.match(result.message ?? "", /source-owner-instance/);
    } finally {
      await sourceLease.release();
    }
  });

  test("refuses merge for a managed worktree captured from a detached source checkout", async () => {
    const { parent, repository } = await makeRepository(
      "merge-detached-source"
    );
    execFileSync("git", ["-C", repository, "checkout", "--detach"], {
      stdio: "ignore",
    });
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await fs.writeFile(
      path.join(info.worktreePath, "managed.txt"),
      "managed\n"
    );

    const result = await instance.completeManagedRun(info, { merge: true });

    assert.strictEqual(result.mergeOutcome, "blocked");
    assert.match(result.message ?? "", /detached/);
  });

  test("keeps a landed managed directory when keep is true", async () => {
    const { parent, repository } = await makeRepository("managed-keep");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await fs.writeFile(path.join(info.worktreePath, "kept.txt"), "kept\n");

    const result = await instance.completeManagedRun(info, { keep: true });

    assert.strictEqual(result.landingOutcome, "landed");
    assert.strictEqual(result.directoryOutcome, "kept");
    assert.strictEqual(result.branchState, "present");
    assert.strictEqual(
      await fs.readFile(path.join(info.worktreePath, "kept.txt"), "utf8"),
      "kept\n"
    );
  });

  test("handles no-change runs independently from directory retention", async () => {
    const removed = await makeRepository("managed-no-change-remove");
    const removedManager = manager(removed.parent);
    const removedInfo = await ensureManaged(removedManager, removed.repository);
    const removedResult = await removedManager.completeManagedRun(removedInfo);
    assert.strictEqual(removedResult.landingOutcome, "no-changes");
    assert.strictEqual(removedResult.directoryOutcome, "removed");
    assert.strictEqual(removedResult.branchState, "deleted");
    assert.strictEqual(
      await removedManager.readManagedWorktreeRecord(
        removed.repository,
        removedInfo.branchName
      ),
      undefined
    );

    const kept = await makeRepository("managed-no-change-keep");
    const keptManager = manager(kept.parent);
    const keptInfo = await ensureManaged(keptManager, kept.repository);
    const keptResult = await keptManager.completeManagedRun(keptInfo, {
      keep: true,
    });
    assert.strictEqual(keptResult.landingOutcome, "no-changes");
    assert.strictEqual(keptResult.directoryOutcome, "kept");
    assert.strictEqual(keptResult.branchState, "present");
    assert.ok(await fs.stat(keptInfo.worktreePath));
  });

  test("blocks a detached or switched managed checkout before staging", async () => {
    const { parent, repository } = await makeRepository("managed-identity");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    execFileSync("git", ["-C", info.worktreePath, "checkout", "--detach"], {
      stdio: "ignore",
    });
    await fs.writeFile(
      path.join(info.worktreePath, "must-remain.txt"),
      "safe\n"
    );

    const result = await instance.completeManagedRun(info);

    assert.strictEqual(result.landingOutcome, "blocked");
    assert.strictEqual(result.directoryOutcome, "kept");
    assert.strictEqual(
      await fs.readFile(
        path.join(info.worktreePath, "must-remain.txt"),
        "utf8"
      ),
      "safe\n"
    );
  });

  test("blocks strict cleanup failure without touching the managed checkout", async () => {
    const { parent, repository } = await makeRepository(
      "managed-cleanup-block"
    );
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await fs.writeFile(
      path.join(info.worktreePath, "must-remain.txt"),
      "safe\n"
    );

    const result = await instance.completeManagedRun(info, {
      artifactsClean: false,
      cleanupMessage: "hook artifact remains",
    });

    assert.strictEqual(result.landingOutcome, "blocked");
    assert.strictEqual(result.message, "hook artifact remains");
    assert.ok(await fs.stat(info.worktreePath));
    assert.strictEqual(
      execFileSync("git", ["-C", info.worktreePath, "status", "--porcelain"], {
        encoding: "utf8",
      }).trim(),
      "?? must-remain.txt"
    );
  });

  test("lands deliberately tracked prompts and attachments", async () => {
    const { parent, repository } = await makeRepository(
      "managed-tracked-assets"
    );
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    const ctrlyokeRoot = path.join(info.worktreePath, ".ctrlyoke");
    const trackedPaths = [
      ".ctrlyoke/prompts/tracked.prompt.md",
      ".ctrlyoke/attachments/tracked.txt",
    ];
    for (const relativePath of trackedPaths) {
      const absolutePath = path.join(info.worktreePath, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "tracked\n");
    }
    execFileSync(
      "git",
      ["-C", info.worktreePath, "add", "-f", "--", ...trackedPaths],
      { stdio: "ignore" }
    );

    const result = await instance.completeManagedRun(info, { keep: true });

    assert.strictEqual(result.landingOutcome, "landed");
    assert.strictEqual(result.directoryOutcome, "kept");
    assert.deepStrictEqual(
      execFileSync("git", ["-C", info.worktreePath, "ls-files", ".ctrlyoke"], {
        encoding: "utf8",
      })
        .trim()
        .split(/\r?\n/)
        .sort(),
      trackedPaths.map((trackedPath) => trackedPath.replace(/\\/g, "/")).sort()
    );
    assert.ok(await fs.stat(ctrlyokeRoot));
  });

  test("blocks unsafe runtime paths even when deliberately tracked", async () => {
    const { parent, repository } = await makeRepository(
      "managed-unsafe-runtime"
    );
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    const unsafePaths = [
      ".ctrlyoke/certs/server.key",
      ".ctrlyoke/notifications/subscription.json",
      ".ctrlyoke/temp/prompt.txt",
      ".ctrlyoke/logs/session.log",
    ];
    for (const relativePath of unsafePaths) {
      const absolutePath = path.join(info.worktreePath, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "unsafe\n");
    }
    execFileSync(
      "git",
      ["-C", info.worktreePath, "add", "-f", "--", ...unsafePaths],
      { stdio: "ignore" }
    );

    const result = await instance.completeManagedRun(info);

    assert.strictEqual(result.landingOutcome, "blocked");
    assert.match(
      result.message ?? "",
      /unsafe or non-ignored untracked runtime paths/
    );
    for (const relativePath of unsafePaths) {
      assert.match(
        result.message ?? "",
        new RegExp(path.basename(relativePath))
      );
    }
    assert.ok(await fs.stat(info.worktreePath));
  });

  test("blocks untracked prompt output after .gitignore becomes user-owned", async () => {
    const { parent, repository } = await makeRepository(
      "managed-untracked-prompt"
    );
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    const ctrlyokeRoot = path.join(info.worktreePath, ".ctrlyoke");
    const gitignorePath = path.join(ctrlyokeRoot, ".gitignore");
    const generatedGitignore = await fs.readFile(gitignorePath, "utf8");
    await fs.writeFile(
      gitignorePath,
      generatedGitignore.replace("prompts/\n", "").replace(".gitignore\n", "")
    );
    const promptPath = path.join(
      ctrlyokeRoot,
      "prompts",
      "untracked.prompt.md"
    );
    await fs.mkdir(path.dirname(promptPath), { recursive: true });
    await fs.writeFile(promptPath, "untracked\n");

    const result = await instance.completeManagedRun(info);

    assert.strictEqual(result.landingOutcome, "blocked");
    assert.match(result.message ?? "", /untracked runtime paths/);
    assert.match(result.message ?? "", /untracked\.prompt\.md/);
    assert.ok(await fs.stat(info.worktreePath));
  });

  test("rejects untracked nested execution-root runtime paths when its ignore file is absent", async () => {
    const { parent, repository } = await makeRepository(
      "managed-runtime-guard"
    );
    const instance = manager(parent);
    const stateRoot = path.join(repository, "packages", "app");
    await fs.mkdir(stateRoot, { recursive: true });
    const info = await ensureManaged(instance, repository, {
      stateRoot,
      namedWorkspaceRoots: [{ name: "app", fsPath: stateRoot }],
    });
    const runtimeRoot = path.join(
      info.executionWorkspace.executionRoot,
      ".ctrlyoke"
    );
    await fs.rm(path.join(runtimeRoot, ".gitignore"));
    await fs.mkdir(path.join(runtimeRoot, ".runs"), { recursive: true });
    await fs.writeFile(
      path.join(runtimeRoot, ".runs", "runtime.json"),
      "runtime\n"
    );

    const result = await instance.completeManagedRun(info);

    assert.strictEqual(result.landingOutcome, "blocked");
    assert.match(result.message ?? "", /runtime paths/);
    assert.ok(await fs.stat(info.worktreePath));
  });

  test("requires the ownership record and recorded tip for managed branch authority", async () => {
    const { parent, repository } = await makeRepository("managed-authority");
    const instance = manager(parent);
    const prefixBranch = "ctrlyoke/not-owned/branch";
    execFileSync("git", ["-C", repository, "branch", prefixBranch]);
    assert.strictEqual(
      await instance.isManagedBranchOwned(repository, prefixBranch),
      false
    );

    const info = await ensureManaged(instance, repository);
    await info.lease.release();
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "worktree",
        "remove",
        "--force",
        "--",
        info.worktreePath,
      ],
      { stdio: "ignore" }
    );
    execFileSync("git", ["-C", repository, "branch", "-D", info.branchName], {
      stdio: "ignore",
    });
    await fs.writeFile(path.join(repository, "recreated.txt"), "recreated\n");
    execFileSync("git", ["-C", repository, "add", "recreated.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "recreated"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", repository, "branch", info.branchName, "HEAD"]);
    assert.strictEqual(
      await instance.isManagedBranchOwned(repository, info.branchName),
      false
    );
  });

  test("auto-reconciles a record whose worktree Git has already fully forgotten, on plain state load", async () => {
    const { parent, repository } = await makeRepository("management-remove");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await info.lease.release();

    // Simulate what the dashboard showed: the directory is gone and `git
    // worktree prune` has already erased Git's own admin entry, but
    // ctrlyoke's ownership record was never reconciled (e.g. a prior
    // `removeWorktree` attempt recorded "remove-failed"). Neither
    // `git worktree list` nor a plain `git worktree remove` can do anything
    // further with this branch's admin entry.
    await fs.rm(info.worktreePath, { recursive: true, force: true });
    execFileSync("git", ["-C", repository, "worktree", "prune"], {
      stdio: "ignore",
    });

    // A plain, read-oriented state load (mirroring what the dashboard fires
    // on mount and on every Refresh) must reconcile this automatically —
    // the user should never have to click a button just to make a ghost
    // entry that Git itself has already forgotten disappear.
    const stateAfterLoad = await instance.getManagementState(repository);
    const reconciledOnLoad = stateAfterLoad.entries.find(
      (entry) => entry.branchName === info.branchName
    );
    // The branch still exists (only the directory was cleared), so the
    // record is retained for branch cleanup, but it must no longer read as
    // a stale admin entry needing repair.
    assert.ok(reconciledOnLoad, "the reconciled record stays visible");
    assert.strictEqual(reconciledOnLoad?.stale, false);
    assert.strictEqual(reconciledOnLoad?.directoryState, "removed");

    const record = await instance.readManagedWorktreeRecord(
      repository,
      info.branchName
    );
    assert.strictEqual(record?.directoryState, "removed");

    // A subsequent explicit Remove on the now-reconciled record must still
    // be a safe no-op rather than throwing.
    await instance.applyManagementAction({
      sourceCheckoutRoot: repository,
      action: WORKTREE_MANAGEMENT_ACTIONS.REMOVE,
      branchName: info.branchName,
      confirmed: true,
    });

    const stateAfterRemove = await instance.getManagementState(repository);
    const reconciledAfterRemove = stateAfterRemove.entries.find(
      (entry) => entry.branchName === info.branchName
    );
    assert.ok(reconciledAfterRemove, "the reconciled record stays visible");
    assert.strictEqual(reconciledAfterRemove?.stale, false);
    assert.strictEqual(reconciledAfterRemove?.directoryState, "removed");
  });

  test("reconciles and force-removes a worktree whose directory survives its Git admin entry", async () => {
    const { parent, repository } = await makeRepository(
      "management-orphan-dir"
    );
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await info.lease.release();

    // Simulate a Windows-style remove-behind: Git's own admin dir for this
    // worktree disappears (e.g. a prior removal unregistered it before a
    // locked file blocked deleting the directory), but the worktree
    // directory itself - including its now-orphaned `.git` file - survives
    // on disk. `git worktree repair` can never fix this: with no admin dir
    // left to reconnect to, it can only report "unable to locate repository".
    const gitFileContents = await fs.readFile(
      path.join(info.worktreePath, ".git"),
      "utf8"
    );
    const gitdirMatch = gitFileContents.match(/^gitdir:\s*(.+)$/m);
    assert.ok(gitdirMatch, "the worktree's .git file names its admin dir");
    await fs.rm(path.resolve(info.worktreePath, gitdirMatch![1].trim()), {
      recursive: true,
      force: true,
    });

    const listed = execFileSync(
      "git",
      ["-C", repository, "worktree", "list", "--porcelain"],
      { encoding: "utf8" }
    );
    assert.ok(
      !listed
        .replace(/\\/g, "/")
        .includes(info.worktreePath.replace(/\\/g, "/")),
      "Git no longer lists this worktree at all"
    );
    await assert.doesNotReject(
      fs.access(info.worktreePath),
      "the leftover directory still exists on disk"
    );

    // A plain refresh must reconcile it without ever requiring "repair" -
    // and without touching the leftover directory itself.
    const state = await instance.getManagementState(repository);
    const entry = state.entries.find(
      (candidate) => candidate.branchName === info.branchName
    );
    assert.ok(entry, "the reconciled record stays visible for branch cleanup");
    assert.strictEqual(entry?.stale, false);
    assert.strictEqual(entry?.directoryState, "removed");
    await assert.doesNotReject(fs.access(info.worktreePath));

    // Force remove must actually clear the leftover directory instead of
    // dead-ending on a "repair it first" refusal that can never be resolved.
    await instance.applyManagementAction({
      sourceCheckoutRoot: repository,
      action: WORKTREE_MANAGEMENT_ACTIONS.FORCE_REMOVE,
      branchName: info.branchName,
      confirmed: true,
    });
    await assert.rejects(fs.access(info.worktreePath));
  });

  test("drops the ownership record once both directory and branch are gone", async () => {
    const { parent, repository } = await makeRepository("management-tombstone");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await info.lease.release();

    await fs.rm(info.worktreePath, { recursive: true, force: true });
    execFileSync("git", ["-C", repository, "worktree", "prune"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", repository, "branch", "-D", info.branchName], {
      stdio: "ignore",
    });

    await instance.applyManagementAction({
      sourceCheckoutRoot: repository,
      action: WORKTREE_MANAGEMENT_ACTIONS.REMOVE,
      branchName: info.branchName,
      confirmed: true,
    });

    const state = await instance.getManagementState(repository);
    assert.strictEqual(
      state.entries.some((entry) => entry.branchName === info.branchName),
      false
    );
    assert.strictEqual((await managedRecordFiles(repository)).length, 0);
  });

  test("re-verifies branch state on every load instead of trusting an already-reconciled directoryState, and lets cleanup-branch settle a branch deleted outside ctrlyoke", async () => {
    const { parent, repository } = await makeRepository(
      "management-tombstone-late-branch-delete"
    );
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await info.lease.release();

    // The worktree directory and Git's admin entry disappear first, while the
    // branch itself is still present — this reconciles `directoryState` to
    // "removed" but leaves `branchState: "present"`, exactly like the
    // dashboard card the bug report described.
    await fs.rm(info.worktreePath, { recursive: true, force: true });
    execFileSync("git", ["-C", repository, "worktree", "prune"], {
      stdio: "ignore",
    });
    const firstLoad = await instance.getManagementState(repository);
    const firstEntry = firstLoad.entries.find(
      (entry) => entry.branchName === info.branchName
    );
    assert.ok(firstEntry, "the worktree-only reconciliation stays visible");
    assert.strictEqual(firstEntry?.directoryState, "removed");
    assert.strictEqual(firstEntry?.branchState, "present");

    // Only afterward does the branch itself disappear — e.g. deleted by hand,
    // or by a `cleanup-branch` attempt that succeeded in Git but failed
    // before its record write landed.
    execFileSync("git", ["-C", repository, "branch", "-D", info.branchName], {
      stdio: "ignore",
    });

    // A plain refresh must catch the now-deleted branch and drop the
    // tombstone, even though `directoryState` was already "removed" —
    // it must never keep serving a cached, stale "present" branchState.
    const secondLoad = await instance.getManagementState(repository);
    assert.strictEqual(
      secondLoad.entries.some((entry) => entry.branchName === info.branchName),
      false
    );
    assert.strictEqual((await managedRecordFiles(repository)).length, 0);
  });

  test("cleanup-branch settles instead of throwing when the branch is already gone", async () => {
    const { parent, repository } = await makeRepository(
      "management-cleanup-already-deleted"
    );
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await info.lease.release();

    await fs.rm(info.worktreePath, { recursive: true, force: true });
    execFileSync("git", ["-C", repository, "worktree", "prune"], {
      stdio: "ignore",
    });
    // Reconcile the directory first so the record's directoryState is
    // already "removed" before the branch disappears — matching the
    // sequence from the bug report — then delete the branch out from under
    // the still-cached record.
    await instance.getManagementState(repository);
    execFileSync("git", ["-C", repository, "branch", "-D", info.branchName], {
      stdio: "ignore",
    });

    // Retrying "Delete branch" on an already-gone branch must settle
    // cleanly instead of repeating the raw `git rev-parse` failure forever.
    await assert.doesNotReject(
      instance.applyManagementAction({
        sourceCheckoutRoot: repository,
        action: WORKTREE_MANAGEMENT_ACTIONS.CLEANUP_BRANCH,
        branchName: info.branchName,
        confirmed: true,
      })
    );

    const state = await instance.getManagementState(repository);
    assert.strictEqual(
      state.entries.some((entry) => entry.branchName === info.branchName),
      false
    );
  });

  test("syncs a named worktree with the source checkout in both directions", async () => {
    const { parent, repository } = await makeRepository("sync-basic");
    const instance = manager(parent);
    const sourceBranchName = execFileSync(
      "git",
      ["-C", repository, "branch", "--show-current"],
      { encoding: "utf8" }
    ).trim();
    execFileSync("git", ["-C", repository, "branch", "feature/sync"]);
    const info = await resolve(instance, repository, "feature/sync");
    await info.lease.release();

    await fs.writeFile(
      path.join(info.worktreePath, "worktree-file.txt"),
      "from worktree\n"
    );
    execFileSync("git", ["-C", info.worktreePath, "add", "worktree-file.txt"]);
    execFileSync(
      "git",
      ["-C", info.worktreePath, "commit", "-m", "worktree change"],
      { stdio: "ignore" }
    );

    await fs.writeFile(
      path.join(repository, "source-file.txt"),
      "from source\n"
    );
    execFileSync("git", ["-C", repository, "add", "source-file.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "source change"], {
      stdio: "ignore",
    });

    const result = await instance.syncNamedWorktree({
      sourceCheckoutRoot: repository,
      worktreePath: info.worktreePath,
    });

    assert.strictEqual(result.sourceBranch, sourceBranchName);
    assert.strictEqual(result.worktreeBranch, "feature/sync");
    assert.strictEqual(result.intoSource.mergeOutcome, "merge-commit");
    // By the time this direction runs, `intoSource` has already landed a
    // merge commit on main containing both branches' changes, so bringing
    // main back into the worktree branch is a trivial fast-forward rather
    // than a second merge commit.
    assert.strictEqual(result.intoWorktree.mergeOutcome, "fast-forward");

    const exists = async (target: string) =>
      fs.stat(target).then(
        () => true,
        () => false
      );
    assert.strictEqual(
      await exists(path.join(repository, "worktree-file.txt")),
      true
    );
    assert.strictEqual(
      await exists(path.join(info.worktreePath, "source-file.txt")),
      true
    );
  });

  test("blocks sync when the named worktree has uncommitted changes", async () => {
    const { parent, repository } = await makeRepository("sync-dirty");
    const instance = manager(parent);
    execFileSync("git", ["-C", repository, "branch", "feature/dirty"]);
    const info = await resolve(instance, repository, "feature/dirty");
    await info.lease.release();

    await fs.writeFile(
      path.join(info.worktreePath, "dirty.txt"),
      "uncommitted\n"
    );

    const result = await instance.syncNamedWorktree({
      sourceCheckoutRoot: repository,
      worktreePath: info.worktreePath,
    });

    assert.strictEqual(result.intoWorktree.mergeOutcome, "blocked");
    assert.match(result.intoWorktree.message ?? "", /uncommitted changes/);
  });

  test("refuses to sync a managed worktree", async () => {
    const { parent, repository } = await makeRepository("sync-managed-guard");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await info.lease.release();

    await assert.rejects(
      instance.syncNamedWorktree({
        sourceCheckoutRoot: repository,
        worktreePath: info.worktreePath,
      }),
      /workflow's own merge action/
    );
  });
});
