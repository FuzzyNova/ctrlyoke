import * as fs from "fs/promises";

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
 * container-mounted filesystems elsewhere, the retry budget is small enough to
 * be invisible on a genuinely failing write, and one code path is worth more
 * than a platform branch nothing exercises.
 */

/** Errors that mean "the destination is momentarily held", not "denied". */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Bounded so a real permission problem still surfaces promptly: the observed
 * collisions clear within a few milliseconds, and the caller is usually an
 * executor writing run state a client is waiting on.
 */
const RENAME_ATTEMPTS = 10;
const RENAME_INITIAL_DELAY_MS = 5;
const RENAME_MAX_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_RENAME_CODES.has(code);
}

/**
 * `fs.rename`, retrying only the transient sharing codes above. Every other
 * failure — `ENOENT`, `ENOTEMPTY`, `EEXIST`, `EXDEV` — is a real conflict the
 * caller must see immediately, so it propagates on the first attempt.
 *
 * `rename` is injectable for tests; nothing in production passes it.
 */
export async function renameWithTransientRetry(
  source: string,
  destination: string,
  options: {
    attempts?: number;
    rename?: (source: string, destination: string) => Promise<void>;
  } = {}
): Promise<void> {
  const attempts = options.attempts ?? RENAME_ATTEMPTS;
  const rename = options.rename ?? fs.rename;
  let delay = RENAME_INITIAL_DELAY_MS;

  for (let attempt = 1; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (attempt >= attempts || !isTransientRenameError(error)) {
        throw error;
      }
      await sleep(delay);
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
  contents: string | Buffer
): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  try {
    await fs.writeFile(tempPath, contents);
    await renameWithTransientRetry(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}
