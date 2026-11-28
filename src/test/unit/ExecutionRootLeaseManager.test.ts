import * as assert from "assert";
import * as fs from "fs/promises";
import { execFileSync } from "child_process";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  EXECUTION_LEASE_PURPOSES,
  RUNNER_IDS,
} from "../../types/DashboardConstants";
import {
  ExecutionLeaseConflictError,
  ExecutionRootLeaseManager,
  isSiblingMergeLeaseConflict,
  type ExecutionLease,
  type ExecutionLeaseRequest,
} from "../../core/orchestration/ExecutionRootLeaseManager";

suite("ExecutionRootLeaseManager", function () {
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

  test("allows only leases named by a delegated request chain", async () => {
    const root = await tempDirectory("delegation");
    try {
      const rootLease = await ExecutionRootLeaseManager.acquire(
        request(root, "shared-native", "ancestor")
      );
      const secondAncestor = await ExecutionRootLeaseManager.acquire(
        request(root, "shared-native", "second-ancestor")
      );
      const delegatedRequest = {
        ...request(root, "exclusive-worktree", "child"),
        delegationChain: [rootLease.ownerToken, secondAncestor.ownerToken],
      };
      const child = await ExecutionRootLeaseManager.acquire(delegatedRequest);
      assert.deepStrictEqual(
        child.delegationChain,
        delegatedRequest.delegationChain
      );
      await child.release();

      await assert.rejects(
        ExecutionRootLeaseManager.acquire({
          ...request(root, "exclusive-worktree", "unrelated"),
          delegationChain: ["not-an-owner-token"],
        }),
        ExecutionLeaseConflictError
      );
      await rootLease.release();
      await secondAncestor.release();
    } finally {
      await removeDirectory(root);
    }
  });

  suite("D4d rule 2: inheriting siblings", () => {
    // Exclusive requests, so the shared-native + shared-native rule cannot be
    // what admits them.
    async function withParent(
      name: string,
      body: (root: string, parentToken: string) => Promise<void>
    ): Promise<void> {
      const root = await tempDirectory(name);
      try {
        const parent = await ExecutionRootLeaseManager.acquire(
          request(root, "exclusive-worktree", "parent")
        );
        try {
          await body(root, parent.ownerToken);
        } finally {
          await parent.release();
        }
      } finally {
        await removeDirectory(root);
      }
    }

    function sibling(
      root: string,
      suffix: string,
      chain: string[],
      purpose?: ExecutionLeaseRequest["purpose"]
    ): ExecutionLeaseRequest {
      return {
        ...request(root, "exclusive-worktree", suffix),
        delegationChain: chain,
        ...(purpose ? { purpose } : {}),
      };
    }

    test("two delegated editing leases with the same immediate delegator share the root", async () => {
      await withParent("siblings", async (root, parentToken) => {
        const first = await ExecutionRootLeaseManager.acquire(
          sibling(root, "first", ["root-token", parentToken])
        );
        // A sibling's chain need only end with the same delegator.
        const second = await ExecutionRootLeaseManager.acquire(
          sibling(root, "second", [parentToken])
        );
        assert.strictEqual(
          (await ExecutionRootLeaseManager.inspectLeases(root)).length,
          3
        );
        await first.release();
        await second.release();
      });
    });

    test("chains ending in different delegators still conflict", async () => {
      await withParent("other-delegator", async (root, parentToken) => {
        const first = await ExecutionRootLeaseManager.acquire(
          sibling(root, "first", [parentToken])
        );
        try {
          await assert.rejects(
            ExecutionRootLeaseManager.acquire(
              sibling(root, "nephew", [parentToken, "another-child"])
            ),
            (error: unknown) => {
              assert.ok(error instanceof ExecutionLeaseConflictError);
              assert.strictEqual(
                error.conflict.lease.ownerToken,
                first.ownerToken
              );
              return true;
            }
          );
          await assert.rejects(
            ExecutionRootLeaseManager.acquire(
              request(root, "exclusive-worktree", "chainless")
            ),
            ExecutionLeaseConflictError
          );
        } finally {
          await first.release();
        }
      });
    });

    test("a sibling's merge lease and an inheriting sibling's lease exclude each other", async () => {
      const merge = EXECUTION_LEASE_PURPOSES.MERGE;
      await withParent("merge-beside-editor", async (root, parentToken) => {
        const editor = await ExecutionRootLeaseManager.acquire(
          sibling(root, "editor", [parentToken])
        );
        try {
          await assert.rejects(
            ExecutionRootLeaseManager.acquire(
              sibling(root, "merge", [parentToken], merge)
            ),
            (error: unknown) => {
              assert.ok(error instanceof ExecutionLeaseConflictError);
              assert.deepStrictEqual(
                error.conflictingLeases.map((lease) => lease.ownerToken),
                [editor.ownerToken]
              );
              return true;
            }
          );
        } finally {
          await editor.release();
        }

        const mergeLease = await ExecutionRootLeaseManager.acquire(
          sibling(root, "merge", [parentToken], merge)
        );
        try {
          await assert.rejects(
            ExecutionRootLeaseManager.acquire(
              sibling(root, "late-editor", [parentToken])
            ),
            ExecutionLeaseConflictError
          );
          // Shared-native, the mode an inheriting child actually requests,
          // is refused too.
          await assert.rejects(
            ExecutionRootLeaseManager.acquire({
              ...request(root, "shared-native", "late-shared"),
              delegationChain: [parentToken],
            }),
            ExecutionLeaseConflictError
          );
        } finally {
          await mergeLease.release();
        }
      });
    });
  });

  test("arbitrates through the shared file lock and frees it after every operation", async () => {
    const root = await tempDirectory("arbitration");
    try {
      const scope = await ExecutionRootLeaseManager.getScopeInfo(root);
      assert.strictEqual(
        path.basename(scope.arbitrationPath),
        "arbitration.lock"
      );
      // A dead holder's arbitration lock is reclaimed like any stale lock.
      await fs.mkdir(scope.storageRoot, { recursive: true });
      await fs.writeFile(scope.arbitrationPath, "999999 stale", "utf8");
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(scope.arbitrationPath, past, past);

      const lease = await ExecutionRootLeaseManager.acquire(
        request(root, "exclusive-worktree", "arbitration")
      );
      await lease.updateHeartbeat();
      await lease.release();

      const leftovers = (await fs.readdir(scope.storageRoot)).filter((name) =>
        name.startsWith("arbitration.lock")
      );
      assert.deepStrictEqual(leftovers, []);
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

  test("removes malformed leases and continues acquisition", async () => {
    const root = await tempDirectory("malformed");
    try {
      const scope = await ExecutionRootLeaseManager.getScopeInfo(root);
      await fs.mkdir(scope.leasesRoot, { recursive: true });
      await fs.writeFile(
        path.join(scope.storageRoot, "scope.json"),
        JSON.stringify({ scopeIdentity: scope.identity }),
        "utf8"
      );
      const malformedNames = ["empty.json", "truncated.json"];
      await fs.writeFile(path.join(scope.leasesRoot, malformedNames[0]), "");
      await fs.writeFile(
        path.join(scope.leasesRoot, malformedNames[1]),
        '{"ownerToken":'
      );

      const lease = await ExecutionRootLeaseManager.acquire(
        request(root, "exclusive-worktree", "after-malformed")
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
  test("D4d: persists a merge purpose and reports every conflicting lease", async () => {
    const root = await tempDirectory("merge-purpose");
    try {
      const first = await ExecutionRootLeaseManager.acquire(
        request(root, "shared-native", "first")
      );
      const second = await ExecutionRootLeaseManager.acquire(
        request(root, "shared-native", "second")
      );
      try {
        const error = await ExecutionRootLeaseManager.acquire({
          ...request(root, "exclusive-worktree", "merge"),
          purpose: EXECUTION_LEASE_PURPOSES.MERGE,
        }).then(
          () => assert.fail("two shared leases must refuse an exclusive one"),
          (caught: unknown) => caught
        );
        assert.ok(error instanceof ExecutionLeaseConflictError);
        assert.strictEqual(
          error.conflict.lease.ownerToken,
          error.conflictingLeases[0]?.ownerToken
        );
        assert.deepStrictEqual(
          error.conflictingLeases.map((lease) => lease.ownerToken).sort(),
          [first.ownerToken, second.ownerToken].sort()
        );
      } finally {
        await first.release();
        await second.release();
      }

      const merge = await ExecutionRootLeaseManager.acquire({
        ...request(root, "exclusive-worktree", "merge"),
        purpose: EXECUTION_LEASE_PURPOSES.MERGE,
        delegationChain: ["parent-token"],
      });
      try {
        assert.strictEqual(merge.purpose, EXECUTION_LEASE_PURPOSES.MERGE);
        const [persisted] = await ExecutionRootLeaseManager.inspectLeases(root);
        assert.strictEqual(
          persisted?.lease.purpose,
          EXECUTION_LEASE_PURPOSES.MERGE
        );
        const editing = await ExecutionRootLeaseManager.acquire(
          request(root, "exclusive-worktree", "editing")
        ).then(
          () => assert.fail("a merge lease is still exclusive"),
          (caught: unknown) => caught
        );
        assert.ok(editing instanceof ExecutionLeaseConflictError);
      } finally {
        await merge.release();
      }
      // An ordinary lease records no purpose.
      const plain = await ExecutionRootLeaseManager.acquire(
        request(root, "exclusive-worktree", "plain")
      );
      assert.strictEqual(plain.purpose, undefined);
      await plain.release();
    } finally {
      await removeDirectory(root);
    }
  });

  suite("D4d sibling merge conflict classification", () => {
    const merge = EXECUTION_LEASE_PURPOSES.MERGE;
    const chain = ["root", "parent"];

    test("waits only on merge leases with the same immediate delegator", () => {
      assert.strictEqual(
        isSiblingMergeLeaseConflict(chain, [
          { purpose: merge, delegationChain: ["root", "parent"] },
          { purpose: merge, delegationChain: ["parent"] },
        ]),
        true
      );
    });

    test("an editing lease, even a delegated sibling's, never waits", () => {
      assert.strictEqual(
        isSiblingMergeLeaseConflict(chain, [
          { delegationChain: ["root", "parent"] },
        ]),
        false
      );
      assert.strictEqual(
        isSiblingMergeLeaseConflict(chain, [
          { purpose: merge, delegationChain: ["root", "parent"] },
          { delegationChain: ["root", "parent"] },
        ]),
        false,
        "one editing lease among sibling merges is enough to fail fast"
      );
    });

    test("a merge lease from another delegator or with no chain never waits", () => {
      assert.strictEqual(
        isSiblingMergeLeaseConflict(chain, [
          { purpose: merge, delegationChain: ["root"] },
        ]),
        false
      );
      assert.strictEqual(
        isSiblingMergeLeaseConflict(chain, [{ purpose: merge }]),
        false
      );
    });

    test("a request with no chain, or no conflict, never waits", () => {
      const sibling = { purpose: merge, delegationChain: ["parent"] };
      assert.strictEqual(
        isSiblingMergeLeaseConflict(undefined, [sibling]),
        false
      );
      assert.strictEqual(isSiblingMergeLeaseConflict([], [sibling]), false);
      assert.strictEqual(isSiblingMergeLeaseConflict(chain, []), false);
    });
  });
});
