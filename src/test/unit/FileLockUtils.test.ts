import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import {
  FileLockTimeoutError,
  FileLockUnavailableError,
  withFileLock,
} from "../../utils/FileLockUtils";
import { errorWithCode } from "../helpers/errnoError";

suite("FileLockUtils", () => {
  const tempPaths: string[] = [];

  // Liveness tests use a real heartbeat (setInterval at staleMs / 3) on the
  // test's own event loop, and judge staleness by wall-clock time against the
  // lock's mtime. A stall longer than staleMs - staleMs / 3 therefore makes a
  // live holder look stale. A 120 ms window flaked under `npm test`, where
  // concurrent extension hosts and Vitest stall the loop well past that. This
  // window tolerates about a second of stall. Holders keep the lock for longer
  // than the window, so the heartbeat, not the initial mtime, is what keeps it
  // fresh.
  const HEARTBEAT_STALE_MS = 1_500;
  const HOLD_PAST_STALE_MS = 2_000;

  function tempTarget(name?: string): string {
    const p = path.join(
      os.tmpdir(),
      `cy-lock-${name ?? Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    tempPaths.push(p);
    tempPaths.push(`${p}.lock`);
    return p;
  }

  afterEach(async () => {
    for (const p of tempPaths.splice(0)) {
      try {
        await fs.unlink(p);
      } catch {
        // best-effort
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("withFileLock", () => {
    test("action executes and result is returned", async () => {
      const target = tempTarget();
      const result = await withFileLock(target, async () => 42);
      assert.strictEqual(result, 42);
    });

    test("action receives no argument and can close over state", async () => {
      const target = tempTarget();
      let sideEffect = 0;
      await withFileLock(target, async () => {
        sideEffect = 99;
      });
      assert.strictEqual(sideEffect, 99);
    });

    test("lock file is cleaned up after successful action", async () => {
      const target = tempTarget();
      const lockPath = `${target}.lock`;
      await withFileLock(target, async () => {
        /* no-op */
      });
      await assert.rejects(
        () => fs.access(lockPath),
        "lock file should not exist after unlock"
      );
    });

    test("lock file is cleaned up when action throws", async () => {
      const target = tempTarget();
      const lockPath = `${target}.lock`;
      await assert.rejects(
        () =>
          withFileLock(target, async () => {
            throw new Error("action failed");
          }),
        /action failed/
      );
      await assert.rejects(
        () => fs.access(lockPath),
        "lock file should be cleaned up after error"
      );
    });

    test("sequential callers each complete their action", async () => {
      const target = tempTarget();
      const results: number[] = [];
      await withFileLock(target, async () => {
        results.push(1);
      });
      await withFileLock(target, async () => {
        results.push(2);
      });
      assert.deepStrictEqual(results, [1, 2]);
    });

    test("stale lock (old mtime) is overridden — second caller proceeds", async () => {
      const target = tempTarget();
      const lockPath = `${target}.lock`;

      // Create a stale lock (mtime > LOCK_STALE_MS = 30s ago)
      await fs.writeFile(lockPath, `99999 stale-lock`, "utf8");

      // Backdate the mtime by 60 seconds to make it "stale"
      const pastTime = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, pastTime, pastTime);

      // withFileLock should detect stale lock, remove it, and proceed
      let executed = false;
      await withFileLock(target, async () => {
        executed = true;
      });
      assert.strictEqual(
        executed,
        true,
        "action should execute despite stale lock"
      );
    });

    test("heartbeat keeps a long-running holder exclusive", async () => {
      const target = tempTarget();
      const order: string[] = [];
      let releaseHolder!: () => void;
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holder = withFileLock(
        target,
        async () => {
          order.push("holder-start");
          await holderGate;
          order.push("holder-end");
        },
        { staleMs: HEARTBEAT_STALE_MS }
      );
      while (!order.includes("holder-start"))
        await new Promise((resolve) => setTimeout(resolve, 1));
      const waiter = withFileLock(
        target,
        async () => {
          order.push("waiter");
        },
        {
          staleMs: HEARTBEAT_STALE_MS,
          timeoutMs: HOLD_PAST_STALE_MS * 5,
        }
      );
      await new Promise((resolve) => setTimeout(resolve, HOLD_PAST_STALE_MS));
      assert.deepStrictEqual(order, ["holder-start"]);
      releaseHolder();
      await Promise.all([holder, waiter]);
      assert.deepStrictEqual(order, ["holder-start", "holder-end", "waiter"]);
    });

    test("waits past timeout while a holder heartbeat stays fresh", async () => {
      const target = tempTarget();
      let releaseHolder!: () => void;
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holder = withFileLock(target, async () => holderGate, {
        staleMs: HEARTBEAT_STALE_MS,
      });
      const lockPath = `${target}.lock`;
      while (!(await fs.stat(lockPath).catch(() => undefined))) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      let waiterEntered = false;
      const waiter = withFileLock(
        target,
        async () => {
          waiterEntered = true;
        },
        {
          staleMs: HEARTBEAT_STALE_MS,
          timeoutMs: 100,
          waitWhileHolderAlive: true,
          maxWaitMs: HOLD_PAST_STALE_MS * 5,
        }
      );
      await new Promise((resolve) => setTimeout(resolve, HOLD_PAST_STALE_MS));
      assert.strictEqual(waiterEntered, false);
      releaseHolder();
      await Promise.all([holder, waiter]);
      assert.strictEqual(waiterEntered, true);
    });

    // The waiter judges the lock stale, but by the time it renames the lock
    // away the file has changed (here the fake stat reports an old mtime; in
    // the wild, a stalled holder's heartbeat lands late). It restores the lock,
    // which proves an owner is alive, so wait mode must keep waiting past
    // timeoutMs instead of throwing FileLockTimeoutError.
    test("wait mode keeps waiting after restoring a lock that changed during reclaim", async () => {
      const target = tempTarget();
      const lockPath = `${target}.lock`;
      let releaseHolder!: () => void;
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let holderEnded = false;
      const holder = withFileLock(target, async () => {
        await holderGate;
        holderEnded = true;
      });
      while (!(await fs.stat(lockPath).catch(() => undefined))) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      let reportedStale = false;
      let waiterSawHolderEnded: boolean | undefined;
      const waiter = withFileLock(
        target,
        async () => {
          waiterSawHolderEnded = holderEnded;
        },
        {
          timeoutMs: 50,
          waitWhileHolderAlive: true,
          maxWaitMs: 10_000,
          stat: async (filePath) => {
            const stats = await fs.stat(filePath);
            if (filePath !== lockPath || reportedStale) return stats;
            reportedStale = true;
            return Object.assign(
              Object.create(Object.getPrototypeOf(stats)),
              stats,
              { mtimeMs: stats.mtimeMs - 60_000 }
            );
          },
        }
      );

      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.strictEqual(reportedStale, true, "the waiter never judged stale");
      assert.strictEqual(
        await fs.readFile(lockPath, "utf8").then((token) => token.length > 0),
        true,
        "the holder's lock was not restored"
      );
      releaseHolder();
      await Promise.all([holder, waiter]);
      assert.strictEqual(waiterSawHolderEnded, true);
    });

    // The waiter's timeout passes while it is still reclaiming a stale lock
    // (here a slow stat; in the wild, any slow disk or stalled event loop). It
    // has already removed the lock, so it must try to take it rather than
    // throw FileLockTimeoutError and leave the freed lock to someone else.
    test("takes a stale lock it reclaimed after its timeout passed", async () => {
      const target = tempTarget();
      const lockPath = `${target}.lock`;
      await fs.writeFile(lockPath, "99999 stale-lock", "utf8");
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, past, past);

      let delayedStat = false;
      const result = await withFileLock(target, async () => "acquired", {
        timeoutMs: 20,
        stat: async (filePath) => {
          if (filePath === lockPath && !delayedStat) {
            delayedStat = true;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          return fs.stat(filePath);
        },
      });
      assert.strictEqual(delayedStat, true);
      assert.strictEqual(result, "acquired");
    });

    test("wait mode still reclaims a stale lock", async () => {
      const target = tempTarget();
      const lockPath = `${target}.lock`;
      await fs.writeFile(lockPath, "99999 stale-lock", "utf8");
      const past = new Date(Date.now() - 1_000);
      await fs.utimes(lockPath, past, past);

      let acquired = false;
      await withFileLock(
        target,
        async () => {
          acquired = true;
        },
        {
          timeoutMs: 1_000,
          staleMs: 120,
          waitWhileHolderAlive: true,
          maxWaitMs: 2_000,
        }
      );
      assert.strictEqual(acquired, true);
    });

    test("default timeout still expires while a fresh holder is active", async () => {
      const target = tempTarget();
      let releaseHolder!: () => void;
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      // Default stale window: this case is about the timeout, and a short
      // window would let an event-loop stall make the holder look stale.
      const holder = withFileLock(target, async () => holderGate);
      while (!(await fs.stat(`${target}.lock`).catch(() => undefined))) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      try {
        await assert.rejects(
          withFileLock(target, async () => undefined, {
            timeoutMs: 80,
          }),
          FileLockTimeoutError
        );
      } finally {
        releaseHolder();
        await holder;
      }
    });

    test("withFileLock returns the action's resolved value for async actions", async () => {
      const target = tempTarget();
      const value = await withFileLock(target, async () => {
        return { ok: true, message: "done" };
      });
      assert.deepStrictEqual(value, { ok: true, message: "done" });
    });

    // Windows fails an exclusive create with EPERM/EACCES while the previous
    // holder's unlinked lock file is still delete-pending. That is a lock
    // hand-over in progress, not a denial.
    test("retries a lock file that is momentarily delete-pending", async () => {
      for (const code of ["EPERM", "EACCES"]) {
        const target = tempTarget();
        let attempts = 0;
        const result = await withFileLock(target, async () => "acquired", {
          open: async (lockPath, flags) => {
            attempts += 1;
            if (attempts === 1) {
              throw errorWithCode(code);
            }
            return fs.open(lockPath, flags);
          },
        });
        assert.strictEqual(result, "acquired", code);
        assert.strictEqual(attempts, 2, code);
      }
    });

    test("reports the real permission error when the lock can never be created", async () => {
      const target = tempTarget();
      await assert.rejects(
        withFileLock(target, async () => undefined, {
          timeoutMs: 200,
          open: async () => {
            throw errorWithCode("EACCES");
          },
        }),
        (error: NodeJS.ErrnoException) =>
          error instanceof FileLockUnavailableError &&
          error.code === "EACCES" &&
          /delete-pending/.test(error.message) &&
          error.message.includes(`${target}.lock`)
      );
    });

    // On Windows an unlinked file that another process still has open stays
    // delete-pending, and the name refuses every open until that handle
    // closes. Release must therefore free the lock *name* without depending on
    // the unlink completing.
    test("release frees the lock name even when the unlink never completes", async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cy-lock-"));
      try {
        const target = path.join(directory, "state.json");
        const unlinked: string[] = [];
        await withFileLock(target, async () => undefined, {
          // Simulates delete-pending: the call "succeeds" but the file stays.
          unlink: async (filePath) => {
            unlinked.push(filePath);
          },
        });

        const remaining = await fs.readdir(directory);
        assert.ok(!remaining.includes("state.json.lock"), remaining.join());
        assert.strictEqual(unlinked.length, 1);
        assert.match(
          path.basename(unlinked[0]),
          /^state\.json\.lock\.[0-9a-f-]+\.released$/
        );

        const result = await withFileLock(target, async () => "reacquired", {
          timeoutMs: 200,
        });
        assert.strictEqual(result, "reacquired");
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });

    test("stale-lock takeover also moves the old lock aside", async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cy-lock-"));
      try {
        const target = path.join(directory, "state.json");
        const lockPath = `${target}.lock`;
        await fs.writeFile(lockPath, "99999 stale-lock", "utf8");
        const past = new Date(Date.now() - 60_000);
        await fs.utimes(lockPath, past, past);

        const renamed: string[] = [];
        await withFileLock(target, async () => undefined, {
          rename: async (source, destination) => {
            renamed.push(source);
            await fs.rename(source, destination);
          },
        });
        // Once for the stale takeover, once for this holder's own release.
        assert.deepStrictEqual(renamed, [lockPath, lockPath]);
        assert.deepStrictEqual(await fs.readdir(directory), []);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });

    test("release preserves a replacement lock owned by another holder", async () => {
      const target = tempTarget();
      const lockPath = `${target}.lock`;
      await withFileLock(target, async () => {
        await fs.rename(lockPath, `${lockPath}.old`);
        await fs.writeFile(lockPath, "other-owner replacement", "utf8");
      });
      assert.strictEqual(
        await fs.readFile(lockPath, "utf8"),
        "other-owner replacement"
      );
    });

    test("a stale-break waiter does not overlap the holder that won the rename race", async () => {
      const target = tempTarget();
      const lockPath = `${target}.lock`;
      await fs.writeFile(lockPath, "99999 old-format-lock", "utf8");
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, past, past);

      let statObserved!: () => void;
      const observed = new Promise<void>((resolve) => {
        statObserved = resolve;
      });
      let resumeWaiter!: () => void;
      const resume = new Promise<void>((resolve) => {
        resumeWaiter = resolve;
      });
      let insideFirst = false;
      let secondEntered = false;
      let releaseFirst!: () => void;
      const firstMayFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const waiterB = withFileLock(
        target,
        async () => {
          secondEntered = true;
          assert.strictEqual(insideFirst, false, "actions must never overlap");
        },
        {
          stat: async (filePath) => {
            const stats = await fs.stat(filePath);
            if (filePath === lockPath) {
              statObserved();
              await resume;
            }
            return stats;
          },
        }
      );

      await observed;
      const holderA = withFileLock(target, async () => {
        insideFirst = true;
        await firstMayFinish;
        insideFirst = false;
      });
      // Wait until A has replaced the stale lock and entered its action.
      while (!insideFirst)
        await new Promise((resolve) => setTimeout(resolve, 1));
      resumeWaiter();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(secondEntered, false);
      releaseFirst();
      await Promise.all([holderA, waiterB]);
      assert.strictEqual(secondEntered, true);
    });

    test("still times out as held when a sharing error follows a held lock", async () => {
      const target = tempTarget();
      let attempts = 0;
      await assert.rejects(
        withFileLock(target, async () => undefined, {
          timeoutMs: 200,
          open: async () => {
            attempts += 1;
            throw errorWithCode(attempts === 1 ? "EEXIST" : "EPERM");
          },
        }),
        FileLockTimeoutError
      );
    });
  });
});
