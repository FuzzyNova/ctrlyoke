import * as fs from "fs/promises";
import { isTransientSharingError } from "./AtomicFileUtils";

const LOCK_FILE_EXTENSION = ".lock";
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

export interface FileLockOptions {
  timeoutMs?: number;
  /** Injectable for tests; nothing in production passes it. */
  open?: (lockPath: string, flags: "wx") => Promise<fs.FileHandle>;
}

async function acquireLock(
  lockPath: string,
  timeoutMs: number,
  open: NonNullable<FileLockOptions["open"]>
): Promise<void> {
  const startTime = Date.now();
  let lastSharingError: unknown;
  let sawHeldLock = false;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const handle = await open(lockPath, "wx");
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
          // Try to delete stale lock - ignore if another process beat us to it
          try {
            await fs.unlink(lockPath);
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
              throw unlinkError; // Re-throw unexpected errors
            }
          }
          continue;
        }
      } catch (statError) {
        // Lock might have been deleted between EEXIST and stat - retry
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        // Other stat errors shouldn't happen, but continue trying
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  // Only sharing errors and never EEXIST: nobody held the lock, so this is a
  // location we cannot write to. Report that rather than a "lock held" timeout.
  if (!sawHeldLock && lastSharingError !== undefined) {
    throw lastSharingError;
  }
  throw new FileLockTimeoutError(lockPath);
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    // Ignore ENOENT (already deleted by another process) but log other errors
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // always use console.warn here instead of importing Log since file lock utils is used by mcp server
      // which doesn't have access to the vscode logging infrastructure
      console.warn(
        `[FileLockUtils] Failed to release lock ${lockPath}: ${error}`
      );
    }
  }
}

export async function withFileLock<T>(
  targetPath: string,
  action: () => Promise<T>,
  options?: FileLockOptions
): Promise<T> {
  const lockPath = `${targetPath}${LOCK_FILE_EXTENSION}`;
  await acquireLock(
    lockPath,
    options?.timeoutMs ?? LOCK_TIMEOUT_MS,
    options?.open ?? fs.open
  );

  try {
    return await action();
  } finally {
    await releaseLock(lockPath);
  }
}
