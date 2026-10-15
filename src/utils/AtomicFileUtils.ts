import * as fs from "fs/promises";
import * as path from "node:path";
import { randomBytes } from "crypto";

/** Read an editable file, treating only a missing file as an empty document. */
export async function readFileForEdit(
  filePath: string,
  missingContents: string
): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return missingContents;
    }
    throw error;
  }
}

/**
 * Atomic file replacement, hardened against the transient sharing failures
 * Windows raises when something else has the destination open.
 *
 * `fs.rename` over an existing path is `MoveFileEx(..., REPLACE_EXISTING)`,
 * which must delete the destination — and fails with `EPERM`/`EACCES`/`EBUSY`
 * if any other handle on it disallows that. Those errors say "not right now",
 * not "never": the holder is a reader that closes microseconds later, an
 * antivirus scan of a just-created run directory, or a search indexer. ctrlyoke
 * hits this on a lineage's first run, where publishing the run makes a whole
 * directory appear and every connected dashboard client immediately reads the
 * new run's working file (`getRunSummaries` reads one per run) at the same
 * moment the executor writes its first `_runtime` update to it.
 *
 * Deliberately not gated to `win32`: the same codes appear on network and
 * container-mounted filesystems elsewhere, and one code path is worth more than
 * a platform branch nothing exercises.
 */

/** Errors that mean "the path is momentarily held", not "denied". */
const TRANSIENT_SHARING_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Default window for a caller whose failure costs little — a settings sidecar,
 * a search-index shard, a lease file. Long enough to ride out the contention
 * this module exists for, short enough that a genuinely denied write surfaces
 * while the user is still looking at what triggered it.
 */
export const DEFAULT_RENAME_BUDGET_MS = 500;

/**
 * Window for a write whose failure aborts a running workflow.
 *
 * A run's `workflow.ctrlyoke.json` is written throughout execution, so an
 * unlucky rename does not fail one save — it tears down a workflow that may be
 * hours in, and the work in that run is not recoverable by retrying the run.
 * Against that, stalling the executor while the holder lets go costs nothing
 * but time. The budget is therefore sized for the *holder* (an antivirus pass
 * over a freshly published run directory, a cloud-sync client uploading it, a
 * search-index rebuild) rather than for the collisions that clear in a
 * millisecond.
 *
 * The trade this accepts: a *permanently* unwritable file (a read-only
 * attribute, a broken ACL) now stalls that run for five minutes before it
 * reports the same error it used to report at once. Callers pass an
 * `onTransientRetry` that logs, so the stall is diagnosable rather than silent.
 */
export const WORKFLOW_CRITICAL_RENAME_BUDGET_MS = 5 * 60 * 1000;

const RENAME_INITIAL_DELAY_MS = 5;
const RENAME_MAX_DELAY_MS = 1000;

/** Reported to `onTransientRetry` before each wait. */
export interface TransientRenameRetry {
  /** 1-indexed attempt that just failed. */
  attempt: number;
  /** Time since the first attempt started, in ms. */
  elapsedMs: number;
  /** Milliseconds left in the budget once this wait completes. */
  remainingMs: number;
  /** The transient error being retried. */
  error: NodeJS.ErrnoException;
}

export interface RenameRetryOptions {
  /**
   * Total wall-clock window for retries, in ms. The first attempt always runs;
   * `0` therefore means "try once". Retrying stops as soon as the next wait
   * would leave the window.
   */
  budgetMs?: number;
  /** Called before each backoff wait, for logging a write that is taking a while. */
  onTransientRetry?: (retry: TransientRenameRetry) => void;
  /**
   * Injectable for tests; nothing in production passes these. `sleep` and `now`
   * go together — a test that fakes one without the other either busy-loops for
   * the whole real budget or never advances past the first wait.
   */
  rename?: (source: string, destination: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True for the Windows sharing failures that clear once another handle lets go:
 * a rename over a file someone has open, or an exclusive create of a path whose
 * previous file was unlinked but is still delete-pending (`FileLockUtils`).
 */
export function isTransientSharingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_SHARING_CODES.has(code);
}

/**
 * `fs.rename`, retrying only the transient sharing codes above for up to
 * `budgetMs`. Every other failure — `ENOENT`, `ENOTEMPTY`, `EEXIST`, `EXDEV` —
 * is a real conflict the caller must see immediately, so it propagates on the
 * first attempt. That distinction is the whole point of this helper and is why
 * it is not `retryWithBackoff` from `RetryUtils`: that one retries every error
 * and reports exhaustion as `undefined`, which would both delay the callers who
 * act on those codes (`EEXIST` from the staging publish *is* the run-ref
 * collision check) and discard the error they need to act on.
 *
 * On exhaustion the last transient error is rethrown unchanged, so the caller
 * still reports the real `EPERM`.
 */
export async function renameWithTransientRetry(
  source: string,
  destination: string,
  options: RenameRetryOptions = {}
): Promise<void> {
  const budgetMs = options.budgetMs ?? DEFAULT_RENAME_BUDGET_MS;
  const rename = options.rename ?? fs.rename;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let delay = RENAME_INITIAL_DELAY_MS;

  for (let attempt = 1; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!isTransientSharingError(error)) {
        throw error;
      }
      const elapsedMs = now() - startedAt;
      // Never overshoot the window: a wait that would end outside it is a wait
      // the caller did not ask for.
      const wait = Math.min(delay, budgetMs - elapsedMs);
      if (wait <= 0) {
        throw error;
      }
      options.onTransientRetry?.({
        attempt,
        elapsedMs,
        remainingMs: budgetMs - elapsedMs - wait,
        error: error as NodeJS.ErrnoException,
      });
      await sleep(wait);
      delay = Math.min(delay * 2, RENAME_MAX_DELAY_MS);
    }
  }
}

/**
 * Write `contents` to `filePath` so readers only ever observe the whole old
 * file or the whole new one: write a sibling temp file, then replace.
 *
 * The temp file is removed on failure — a leftover `<name>.tmp` is picked up by
 * nothing, but it sits next to the real file in a directory users browse.
 */
export async function writeFileAtomic(
  filePath: string,
  contents: string | Buffer,
  options: RenameRetryOptions = {}
): Promise<void> {
  const tempPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  let tempFile: Awaited<ReturnType<typeof fs.open>> | undefined;
  let tempCreated = false;
  try {
    tempFile = await fs.open(tempPath, "wx");
    tempCreated = true;
    await tempFile.writeFile(contents);
    await tempFile.close();
    tempFile = undefined;
    await renameWithTransientRetry(tempPath, filePath, options);
  } catch (error) {
    await tempFile?.close().catch(() => {});
    if (tempCreated) {
      await fs.unlink(tempPath).catch(() => {});
    }
    throw error;
  }
}

/** Atomically replace a text file while preserving a symlink at its path. */
export async function writeTextFileAtomic(
  filePath: string,
  contents: string
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let targetPath = filePath;
  try {
    targetPath = await fs.realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await writeFileAtomic(targetPath, contents);
}
