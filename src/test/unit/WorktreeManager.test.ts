import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, teardown, test } from "mocha";
import { WorktreeManager } from "../../core/orchestration/WorktreeManager";
import { ExecutionRootLeaseManager } from "../../core/orchestration/ExecutionRootLeaseManager";
import type { RunRef, WorkflowKey } from "../../types/CtrlYokeTypes";

suite("WorktreeManager", function () {
  this.timeout(20_000);

  const temporaryDirectories: string[] = [];

  teardown(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true }))
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

  function manager(parent: string, updates: string[] = []): WorktreeManager {
    return new WorktreeManager({
      worktreeRoot: path.join(parent, "worktrees"),
      updateWorktreeRuntime: async (patch) => {
        updates.push(
          `${patch.lifecycleState ?? "unknown"}:${patch.dirty ?? false}`
        );
      },
    });
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

  test("attaches an existing local branch and creates a missing branch", async () => {
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

  test("blocks failed setup, leaves the directory, and releases its lease", async () => {
    const { parent, repository } = await makeRepository("setup-failed");
    const updates: string[] = [];
    const setup = `node -e "process.exit(7)"`;
    await assert.rejects(
      resolve(manager(parent, updates), repository, "feature/setup-failed", {
        setup,
      }),
      /Worktree setup failed/
    );
    const worktrees = await fs.readdir(path.join(parent, "worktrees"));
    assert.strictEqual(worktrees.length, 1);
    assert.ok(updates.some((value) => value.startsWith("blocked")));
  });

  test("does not retry a failed setup unless explicitly requested", async () => {
    const { parent, repository } = await makeRepository("setup-retry");
    const setup = `node -e "require('fs').writeFileSync('retry-marker.txt', 'ok')"`;
    const first = await resolve(manager(parent), repository, "feature/retry", {
      setup: `node -e "process.exit(7)"`,
    }).catch(() => undefined);
    assert.strictEqual(first, undefined);

    await assert.rejects(
      resolve(manager(parent), repository, "feature/retry", {
        setup,
        existingSetupOutcome: "failed",
      }),
      /use Retry Setup/
    );
    const retried = await resolve(
      manager(parent),
      repository,
      "feature/retry",
      { setup, existingSetupOutcome: "failed", retrySetup: true }
    );
    assert.strictEqual(
      await fs.readFile(
        path.join(retried.worktreePath, "retry-marker.txt"),
        "utf8"
      ),
      "ok"
    );
    await retried.lease.release();
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
    await fs.writeFile(path.join(info.worktreePath, "landed-by-ctrlyoke.txt"), "landed\n");

    const result = await instance.completeManagedRun(info);

    assert.strictEqual(result.landingOutcome, "landed");
    assert.strictEqual(result.directoryOutcome, "removed");
    assert.strictEqual(result.branchState, "present");
    assert.strictEqual(result.branchName, info.branchName);
    assert.strictEqual(result.autoCommitted, true);
    assert.strictEqual(
      (await instance.readManagedWorktreeRecord(repository, info.branchName))?.directoryState,
      "removed"
    );
    assert.strictEqual(
      execFileSync("git", ["-C", repository, "show", "--format=%s", "--no-patch", info.branchName], {
        encoding: "utf8",
      }).trim(),
      "ctrlyoke: land managed workflow changes"
    );
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
    await fs.writeFile(path.join(info.worktreePath, "must-remain.txt"), "safe\n");

    const result = await instance.completeManagedRun(info);

    assert.strictEqual(result.landingOutcome, "blocked");
    assert.strictEqual(result.directoryOutcome, "kept");
    assert.strictEqual(await fs.readFile(path.join(info.worktreePath, "must-remain.txt"), "utf8"), "safe\n");
  });

  test("blocks strict cleanup failure without touching the managed checkout", async () => {
    const { parent, repository } = await makeRepository("managed-cleanup-block");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await fs.writeFile(path.join(info.worktreePath, "must-remain.txt"), "safe\n");

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

  test("rejects runtime paths when the worktree ignore file is absent", async () => {
    const { parent, repository } = await makeRepository("managed-runtime-guard");
    const instance = manager(parent);
    const info = await ensureManaged(instance, repository);
    await fs.rm(path.join(info.worktreePath, ".ctrlyoke", ".gitignore"));
    await fs.mkdir(path.join(info.worktreePath, ".ctrlyoke", ".runs"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(info.worktreePath, ".ctrlyoke", ".runs", "runtime.json"),
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
});
