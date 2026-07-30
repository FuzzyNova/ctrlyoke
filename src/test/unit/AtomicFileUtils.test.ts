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
} from "../../utils/AtomicFileUtils";

function errorWithCode(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

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
    let attempts = 0;
    await assert.rejects(
      renameWithTransientRetry("source", "destination", {
        attempts: 4,
        rename: async () => {
          attempts += 1;
          throw errorWithCode("EPERM");
        },
      }),
      (error: NodeJS.ErrnoException) => error.code === "EPERM",
      "a permanently held destination must still surface the real error"
    );
    assert.strictEqual(attempts, 4, "the retry budget must be bounded");
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
