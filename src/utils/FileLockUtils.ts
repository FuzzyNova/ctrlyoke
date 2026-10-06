import * as crypto from "crypto";
import * as fs from "fs/promises";
import { isTransientSharingError } from "./AtomicFileUtils";

const LOCK_FILE_EXTENSION = ".lock";
const RELEASED_LOCK_SUFFIX = ".released";
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_STALE_MS = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown by {@link withFileLock} when a lock isn't acquired within its timeout. */
export class FileLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out waiting for lock: ${lockPath}`);
    this.name = "FileLockTimeoutError";
  }
}

/**
 * Thrown by {@link withFileLock} when nobody held the lock but its file could
 * never be created. Carries the underlying `code` (`EPERM`/`EACCES`/`EBUSY`) so
 * callers that branch on it keep working; the message says what that code
 * usually means here, which a bare `EPERM ... open` does not.
 */
export class FileLockUnavailableError extends Error {
  readonly code: string | undefined;

  constructor(lockPath: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    super(
      `Cannot create lock file ${lockPath} (${code ?? "unknown error"}). ` +
        `Nothing holds the lock, but the file cannot be opened: either its ` +
        `directory is not writable, or another process still has a handle to ` +
        `a previous lock file at this path that was deleted but not yet ` +
        `released (Windows keeps such a file "delete-pending" and refuses ` +
        `every open until that handle closes). Closing that process, or ` +
        `rebooting, clears it.`
    );
    (this as Error & { cause?: unknown }).cause = cause;
    this.name = "FileLockUnavailableError";
    this.code = code;
  }
}

export interface FileLockOptions {
  timeoutMs?: number;
  /** Injectable for tests; nothing in production passes these. */
  open?: (lockPath: string, flags: "wx") => Promise<fs.FileHandle>;
  rename?: (source: string, destination: string) => Promise<void>;
  unlink?: (filePath: string) => Promise<void>;
}

interface LockFileOperations {
  open: NonNullable<FileLockOptions["open"]>;
  rename: NonNullable<FileLockOptions["rename"]>;
  unlink: NonNullable<FileLockOptions["unlink"]>;
}

/** The lock file {@link withFileLock} uses for `targetPath`. */
export function lockFilePath(targetPath: string): string {
  return `${targetPath}${LOCK_FILE_EXTENSION}`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Remove a lock file so its *name* is free the moment this returns.
 *
 * A plain `unlink` does not guarantee that on Windows: if any other process
 * has the file open (with delete sharing — antivirus, indexers, backup and
 * sync filters all do this), the file only becomes delete-pending, and until
 * that handle closes every create or open of the name fails with `EPERM`. One
 * such handle that never closed wedged an execution lease until reboot.
 * Renaming succeeds under exactly the same sharing conditions, so the lock is
 * first moved to a unique tombstone name and only the tombstone is unlinked;
 * if the tombstone goes delete-pending it is removed by Windows once the
 * holder closes, and it never blocks the lock name. No sweep is needed.
 *
 * Resolves without error when the lock is already gone.
 */
async function removeLockFile(
  lockPath: string,
  ops: LockFileOperations
): Promise<void> {
  const tombstone = `${lockPath}.${crypto.randomUUID()}${RELEASED_LOCK_SUFFIX}`;
  try {
    await ops.rename(lockPath, tombstone);
  } catch (renameError) {
    if (isMissing(renameError)) return;
    // Rename refused (a handle without delete sharing); unlink would be
    // refused for the same reason, but try it so the real error surfaces.
    try {
      await ops.unlink(lockPath);
    } catch (unlinkError) {
      if (!isMissing(unlinkError)) throw unlinkError;
    }
    return;
  }
  // The lock name is already free; a tombstone that survives is harmless.
  await ops.unlink(tombstone).catch(() => undefined);
}

async function acquireLock(
  lockPath: string,
  timeoutMs: number,
  ops: LockFileOperations
): Promise<void> {
  const startTime = Date.now();
  let lastSharingError: unknown;
  let sawHeldLock = false;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const handle = await ops.open(lockPath, "wx");
      try {
        const payload = `${process.pid} ${new Date().toISOString()}`;
        await handle.writeFile(payload, "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      // On Windows, creating a lock file the previous holder just unlinked
      // fails with EPERM/EACCES while the old file is still delete-pending.
      // The lock is being handed over, not denied: wait and retry.
      if (isTransientSharingError(error)) {
        lastSharingError = error;
        await sleep(LOCK_RETRY_DELAY_MS);
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      sawHeldLock = true;

      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          // Another process beating us to the stale lock is fine.
          await removeLockFile(lockPath, ops);
          continue;
        }
      } catch (statError) {
        // Lock might have been deleted between EEXIST and stat - retry
        if (isMissing(statError)) {
          continue;
        }
        // Other stat errors shouldn't happen, but continue trying
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  // Only sharing errors and never EEXIST: nobody held the lock, so the name
  // itself cannot be created. Say why rather than reporting a held lock.
  if (!sawHeldLock && lastSharingError !== undefined) {
    throw new FileLockUnavailableError(lockPath, lastSharingError);
  }
  throw new FileLockTimeoutError(lockPath);
}

async function releaseLock(
  lockPath: string,
  ops: LockFileOperations
): Promise<void> {
  try {
    await removeLockFile(lockPath, ops);
  } catch (error) {
    // always use console.warn here instead of importing Log since file lock utils is used by mcp server
    // which doesn't have access to the vscode logging infrastructure
    console.warn(
      `[FileLockUtils] Failed to release lock ${lockPath}: ${error}`
    );
  }
}

export async function withFileLock<T>(
  targetPath: string,
  action: () => Promise<T>,
  options?: FileLockOptions
): Promise<T> {
  const lockPath = lockFilePath(targetPath);
  const ops: LockFileOperations = {
    open: options?.open ?? fs.open,
    rename: options?.rename ?? fs.rename,
    unlink: options?.unlink ?? fs.unlink,
  };
  await acquireLock(lockPath, options?.timeoutMs ?? LOCK_TIMEOUT_MS, ops);

  try {
    return await action();
  } finally {
    await releaseLock(lockPath, ops);
  }
}
