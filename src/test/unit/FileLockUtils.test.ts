import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { FileLockTimeoutError, withFileLock } from "../../utils/FileLockUtils";
import { errorWithCode } from "../helpers/errnoError";

suite("FileLockUtils", () => {
  const tempPaths: string[] = [];

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
        (error: NodeJS.ErrnoException) => error.code === "EACCES"
      );
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
