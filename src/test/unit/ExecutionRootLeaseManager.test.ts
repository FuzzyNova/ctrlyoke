import * as assert from "assert";
import * as fs from "fs/promises";
import { execFileSync } from "child_process";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { RUNNER_IDS } from "../../types/DashboardConstants";
import {
  ExecutionLeaseConflictError,
  ExecutionRootLeaseManager,
  type ExecutionLease,
  type ExecutionLeaseRequest,
} from "../../core/orchestration/ExecutionRootLeaseManager";

suite("ExecutionRootLeaseManager", function () {
  this.timeout(10_000);

  async function tempDirectory(name: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), `ctrlyoke-lease-${name}-`));
  }

  function request(
    executionRoot: string,
    mode: ExecutionLeaseRequest["mode"],
    suffix: string
  ): ExecutionLeaseRequest {
    return {
      mode,
      stateRoot: executionRoot,
      executionRoot,
      workflowKey: `workflow-${suffix}`,
      runRef: `run-${suffix}`,
      runner: RUNNER_IDS.VSCODE,
      instanceId: `instance-${suffix}`,
    };
  }

  async function removeDirectory(directory: string): Promise<void> {
    await fs.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }

  test("allows shared leases to coexist and releases only its own file", async () => {
    const root = await tempDirectory("shared");
    try {
      const first = await ExecutionRootLeaseManager.acquire(
        request(root, "shared-native", "one")
      );
      const second = await ExecutionRootLeaseManager.acquire(
        request(root, "shared-native", "two")
      );
      const scope = await ExecutionRootLeaseManager.getScopeInfo(root);
      assert.strictEqual((await fs.readdir(scope.leasesRoot)).length, 2);

      await first.release();
      assert.strictEqual((await fs.readdir(scope.leasesRoot)).length, 1);
      await second.release();
      assert.deepStrictEqual(await fs.readdir(scope.leasesRoot), []);
    } finally {
      await removeDirectory(root);
    }
  });

  test("fails immediately on incompatible live leases with actionable ownership", async () => {
    const root = await tempDirectory("conflict");
    try {
      const owner = await ExecutionRootLeaseManager.acquire(
        request(root, "shared-native", "owner")
      );
      await assert.rejects(
        ExecutionRootLeaseManager.acquire(
          request(root, "exclusive-worktree", "blocked")
        ),
        (error: unknown) => {
          assert.ok(error instanceof ExecutionLeaseConflictError);
          assert.match(error.message, /workflow workflow-owner/);
          assert.match(error.message, /run run-owner/);
          assert.match(error.message, /state root/);
          assert.strictEqual(error.retryAction, "retry");
          return true;
        }
      );
      await owner.release();

      const exclusive = await ExecutionRootLeaseManager.acquire(
        request(root, "exclusive-worktree", "exclusive")
      );
      await assert.rejects(
        ExecutionRootLeaseManager.acquire(
          request(root, "shared-native", "blocked-shared")
        ),
        ExecutionLeaseConflictError
      );
      await exclusive.release();
    } finally {
      await removeDirectory(root);
    }
  });

  test("reclaims stale leases of either mode", async () => {
    const root = await tempDirectory("stale");
    try {
      const scope = await ExecutionRootLeaseManager.getScopeInfo(root);
      await fs.mkdir(scope.leasesRoot, { recursive: true });
      await fs.writeFile(
        path.join(scope.storageRoot, "scope.json"),
        JSON.stringify({ scopeIdentity: scope.identity }),
        "utf8"
      );
      for (const [mode, token] of [
        ["shared-native", "stale-shared"],
        ["exclusive-worktree", "stale-exclusive"],
      ] as const) {
        const stale: ExecutionLease = {
          ...request(root, mode, token),
          ownerToken: token,
          pid: 999_999,
          startedAt: 0,
          lastHeartbeat: 0,
        };
        await fs.writeFile(
          path.join(scope.leasesRoot, `${token}.json`),
          JSON.stringify(stale),
          "utf8"
        );
      }

      const lease = await ExecutionRootLeaseManager.acquire(
        request(root, "exclusive-worktree", "new")
      );
      assert.deepStrictEqual(await fs.readdir(scope.leasesRoot), [
        `${lease.ownerToken}.json`,
      ]);
      await lease.release();
    } finally {
      await removeDirectory(root);
    }
  });

  test("owner-token verification protects a successor lease", async () => {
    const root = await tempDirectory("owner-token");
    try {
      const scope = await ExecutionRootLeaseManager.getScopeInfo(root);
      await fs.mkdir(scope.leasesRoot, { recursive: true });
      await fs.writeFile(
        path.join(scope.storageRoot, "scope.json"),
        JSON.stringify({ scopeIdentity: scope.identity }),
        "utf8"
      );
      const staleToken = "stale-owner";
      const successor: ExecutionLease = {
        ...request(root, "shared-native", "successor"),
        ownerToken: "successor-owner",
        pid: process.pid,
        startedAt: Date.now(),
        lastHeartbeat: Date.now(),
      };
      const leasePath = path.join(scope.leasesRoot, `${staleToken}.json`);
      await fs.writeFile(leasePath, JSON.stringify(successor), "utf8");

      await ExecutionRootLeaseManager.release(scope, staleToken);
      assert.ok(await fs.stat(leasePath));
    } finally {
      await removeDirectory(root);
    }
  });

  test("serializes competing exclusive acquisitions", async () => {
    const root = await tempDirectory("race");
    try {
      const results = await Promise.allSettled([
        ExecutionRootLeaseManager.acquire(
          request(root, "exclusive-worktree", "first")
        ),
        ExecutionRootLeaseManager.acquire(
          request(root, "exclusive-worktree", "second")
        ),
      ]);
      const successes = results.filter(
        (
          result
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof ExecutionRootLeaseManager.acquire>>
        > => result.status === "fulfilled"
      );
      const failures = results.filter((result) => result.status === "rejected");
      assert.strictEqual(successes.length, 1);
      assert.strictEqual(failures.length, 1);
      await successes[0].value.release();
    } finally {
      await removeDirectory(root);
    }
  });

  test("keeps scope storage outside the worktree's working tree", async () => {
    const parent = await tempDirectory("git");
    const source = path.join(parent, "source");
    const worktree = path.join(parent, "worktree");
    await fs.mkdir(source);
    try {
      execFileSync("git", ["init", source], { stdio: "ignore" });
      execFileSync("git", ["-C", source, "config", "user.name", "Tests"], {
        stdio: "ignore",
      });
      execFileSync(
        "git",
        ["-C", source, "config", "user.email", "tests@example.com"],
        { stdio: "ignore" }
      );
      await fs.writeFile(path.join(source, "tracked.txt"), "base\n", "utf8");
      execFileSync("git", ["-C", source, "add", "tracked.txt"]);
      execFileSync("git", ["-C", source, "commit", "-m", "initial"]);
      execFileSync("git", [
        "-C",
        source,
        "worktree",
        "add",
        "-b",
        "lease-test",
        worktree,
      ]);

      const lease = await ExecutionRootLeaseManager.acquire(
        request(worktree, "exclusive-worktree", "worktree")
      );
      const scope = await ExecutionRootLeaseManager.getScopeInfo(worktree);
      // Not merely "outside the worktree's own .git": storage must be outside
      // the working tree entirely, or it becomes an untracked file the managed
      // landing path would commit into the user's branch. A move to
      // `<worktree>/.ctrlyoke/` satisfies the narrower check and is exactly the
      // regression this guards. See ExecutionRootScope.scopeStorageRoot.
      // realpath both sides: scope storage is canonicalized, while `worktree`
      // is the raw temp path (which is a symlink on macOS).
      const canonicalWorktree = await fs.realpath(worktree);
      assert.ok(
        !path
          .resolve(scope.storageRoot)
          .startsWith(path.resolve(canonicalWorktree) + path.sep),
        `scope storage ${scope.storageRoot} must not live inside ${worktree}`
      );

      execFileSync("git", ["-C", source, "worktree", "remove", worktree]);
      await lease.release();
      await assert.rejects(
        fs.access(path.join(scope.leasesRoot, `${lease.ownerToken}.json`))
      );
    } finally {
      await removeDirectory(parent);
    }
  });
});
