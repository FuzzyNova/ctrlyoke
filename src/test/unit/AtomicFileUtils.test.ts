/**
 * AtomicFileUtils — replacing a file while something else has it open.
 *
 * Windows raises EPERM/EACCES/EBUSY from `rename` when another handle on the
 * destination disallows the delete that `MOVEFILE_REPLACE_EXISTING` performs.
 * That is a "not right now", and it happens for real on a lineage's first run:
 * publishing the run makes a directory appear, every connected client reads the
 * new run's working file, and the executor writes its first `_runtime` update
 * to that same file microseconds later. Retrying is what makes the write
 * survive it; retrying the *wrong* codes would hide genuine conflicts.
 */
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  renameWithTransientRetry,
  writeFileAtomic,
  WORKFLOW_CRITICAL_RENAME_BUDGET_MS,
} from "../../utils/AtomicFileUtils";
import { errorWithCode } from "../helpers/errnoError";

suite("AtomicFileUtils", () => {
  test("retries a destination that is only momentarily held", async () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      let attempts = 0;
      await renameWithTransientRetry("source", "destination", {
        rename: async () => {
          attempts += 1;
          if (attempts < 3) {
            throw errorWithCode(code);
          }
        },
      });
      assert.strictEqual(
        attempts,
        3,
        `${code} must be retried until the holder releases the destination`
      );
    }
  });

  test("fails immediately on a conflict that will never clear", async () => {
    // ENOTEMPTY/EEXIST/ENOENT are real answers, not contention — retrying them
    // would delay a caller that has to act on them (publishing a run turns
    // EEXIST into a run-ref collision error).
    for (const code of ["ENOENT", "EEXIST", "ENOTEMPTY", "EXDEV"]) {
      let attempts = 0;
      await assert.rejects(
        renameWithTransientRetry("source", "destination", {
          rename: async () => {
            attempts += 1;
            throw errorWithCode(code);
          },
        }),
        (error: NodeJS.ErrnoException) => error.code === code,
        `${code} must propagate unchanged`
      );
      assert.strictEqual(attempts, 1, `${code} must not be retried`);
    }
  });

  test("gives up on a destination that never clears, preserving the error", async () => {
    // A virtual clock keeps the assertion about the *budget* rather than about
    // how fast the machine running the test happens to be.
    let clock = 0;
    let slept = 0;
    let attempts = 0;
    await assert.rejects(
      renameWithTransientRetry("source", "destination", {
        budgetMs: 200,
        now: () => clock,
        sleep: async (ms) => {
          slept += ms;
          clock += ms;
        },
        rename: async () => {
          attempts += 1;
          throw errorWithCode("EPERM");
        },
      }),
      (error: NodeJS.ErrnoException) => error.code === "EPERM",
      "a permanently held destination must still surface the real error"
    );
    assert.ok(attempts > 1, "a transient code must be retried at least once");
    assert.ok(
      slept <= 200,
      `the budget must bound the wait (slept ${slept}ms of 200ms)`
    );
  });

  test("honours a budget large enough to outlast a slow holder", async () => {
    // The regression this guards: the default window was ~555ms, and a holder
    // that kept the destination for longer (an antivirus pass over a freshly
    // published run directory) failed the write and tore down the workflow.
    let clock = 0;
    let attempts = 0;
    let slept = 0;
    await renameWithTransientRetry("source", "destination", {
      budgetMs: WORKFLOW_CRITICAL_RENAME_BUDGET_MS,
      now: () => clock,
      sleep: async (ms) => {
        slept += ms;
        clock += ms;
      },
      rename: async () => {
        attempts += 1;
        // Held for far longer than the default budget would have tolerated.
        if (slept < 90_000) {
          throw errorWithCode("EPERM");
        }
      },
    });
    assert.ok(
      slept >= 90_000,
      "the workflow-critical budget must outlast a minutes-long holder"
    );
    assert.ok(
      attempts < 400,
      `backoff must cap the syscall rate (${attempts} attempts over ${slept}ms)`
    );
  });

  test("tries exactly once when given no budget", async () => {
    let attempts = 0;
    await assert.rejects(
      renameWithTransientRetry("source", "destination", {
        budgetMs: 0,
        rename: async () => {
          attempts += 1;
          throw errorWithCode("EBUSY");
        },
      }),
      (error: NodeJS.ErrnoException) => error.code === "EBUSY"
    );
    assert.strictEqual(attempts, 1, "budgetMs 0 must not retry");
  });

  test("reports each wait so a long stall is diagnosable, not silent", async () => {
    let clock = 0;
    const retries: number[] = [];
    await renameWithTransientRetry("source", "destination", {
      budgetMs: 10_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      onTransientRetry: ({ attempt }) => retries.push(attempt),
      rename: async () => {
        if (retries.length < 3) {
          throw errorWithCode("EPERM");
        }
      },
    });
    assert.deepStrictEqual(
      retries,
      [1, 2, 3],
      "every retried attempt must be reported to the caller"
    );
  });

  test("replaces a file whole and leaves no temp behind", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-atomic-"));
    try {
      const target = path.join(dir, "workflow.ctrlyoke.json");
      await writeFileAtomic(target, '{"revision":1}');
      await writeFileAtomic(target, '{"revision":2}');

      assert.strictEqual(await fs.readFile(target, "utf8"), '{"revision":2}');
      assert.deepStrictEqual(
        await fs.readdir(dir),
        ["workflow.ctrlyoke.json"],
        "the temp file must not outlive the write"
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("cleans up its temp file when the write cannot be published", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-atomic-"));
    try {
      // A directory at the destination makes the rename fail while the temp
      // write succeeds — the one ordering that can strand a `.tmp` sibling.
      const target = path.join(dir, "occupied");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "child"), "keeps it non-empty");

      await assert.rejects(writeFileAtomic(target, "replacement"));
      assert.deepStrictEqual(
        await fs.readdir(dir),
        ["occupied"],
        "a failed write must not leave a temp file next to the real one"
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
