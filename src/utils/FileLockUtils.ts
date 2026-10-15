import * as crypto from "crypto";
import * as fs from "fs/promises";
import { isTransientSharingError } from "./AtomicFileUtils";
import { Log } from "./Log";

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
  stat?: (filePath: string) => Promise<import("fs").Stats>;
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  utimes?: (filePath: string, atime: Date, mtime: Date) => Promise<void>;
  /** Injectable stale window for deterministic liveness tests. */
  staleMs?: number;
}

interface LockFileOperations {
  open: NonNullable<FileLockOptions["open"]>;
  rename: NonNullable<FileLockOptions["rename"]>;
  unlink: NonNullable<FileLockOptions["unlink"]>;
  stat: NonNullable<FileLockOptions["stat"]>;
  readFile: NonNullable<FileLockOptions["readFile"]>;
  utimes: NonNullable<FileLockOptions["utimes"]>;
}

/** The lock file {@link withFileLock} uses for `targetPath`. */
export function lockFilePath(targetPath: string): string {
  return `${targetPath}${LOCK_FILE_EXTENSION}`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function acquireLock(
  lockPath: string,
  timeoutMs: number,
  ops: LockFileOperations,
  staleMs: number
): Promise<string> {
  const startTime = Date.now();
  let lastSharingError: unknown;
  let sawHeldLock = false;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const handle = await ops.open(lockPath, "wx");
      const ownerToken = `${process.pid} ${crypto.randomUUID()}`;
      try {
        await handle.writeFile(ownerToken, "utf8");
      } finally {
        await handle.close();
      }
      return ownerToken;
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
        const stats = await ops.stat(lockPath);
        if (Date.now() - stats.mtimeMs > staleMs) {
          const judgedPayload = await ops
            .readFile(lockPath, "utf8")
            .catch(() => "");
          const tombstone = `${lockPath}.${crypto.randomUUID()}${RELEASED_LOCK_SUFFIX}`;
          try {
            await ops.rename(lockPath, tombstone);
          } catch (renameError) {
            if (!isMissing(renameError)) throw renameError;
            continue;
          }
          const [renamedStats, renamedPayload] = await Promise.all([
            ops.stat(tombstone),
            ops.readFile(tombstone, "utf8"),
          ]).catch(() => [undefined, ""] as const);
          const sameFile =
            !!renamedStats &&
            renamedStats.ino === stats.ino &&
            renamedStats.dev === stats.dev &&
            renamedStats.mtimeMs === stats.mtimeMs &&
            renamedPayload === judgedPayload;
          if (sameFile) {
            await ops.unlink(tombstone).catch(() => undefined);
            continue;
          }
          // The pathname changed after our stale check. Restore without
          // replacing a new owner, then keep polling as though it were held.
          try {
            const restore = await ops.open(lockPath, "wx");
            try {
              await restore.writeFile(renamedPayload, "utf8");
            } finally {
              await restore.close();
            }
            await ops.unlink(tombstone).catch(() => undefined);
          } catch {
            // A competing owner already restored/acquired the lock; the
            // tombstone holds a superseded payload, so don't leave it behind.
            await ops.unlink(tombstone).catch(() => undefined);
          }
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
  ownerToken: string,
  ops: LockFileOperations
): Promise<void> {
  try {
    const currentToken = await ops.readFile(lockPath, "utf8").catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (currentToken === undefined) return;
    if (currentToken !== ownerToken) {
      Log.warn(
        `[FileLockUtils] Lock ownership changed before release: ${lockPath}`
      );
      return;
    }
    const tombstone = `${lockPath}.${crypto.randomUUID()}${RELEASED_LOCK_SUFFIX}`;
    try {
      await ops.rename(lockPath, tombstone);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return;
    }
    const renamedToken = await ops
      .readFile(tombstone, "utf8")
      .catch(() => undefined);
    if (renamedToken === ownerToken) {
      await ops.unlink(tombstone).catch(() => undefined);
    } else if (renamedToken !== undefined) {
      Log.warn(
        `[FileLockUtils] Lock ownership changed during release: ${lockPath}`
      );
      try {
        const restore = await ops.open(lockPath, "wx");
        try {
          await restore.writeFile(renamedToken, "utf8");
        } finally {
          await restore.close();
        }
        await ops.unlink(tombstone).catch(() => undefined);
      } catch {
        // Another owner already holds the lock name.
        await ops.unlink(tombstone).catch(() => undefined);
      }
    }
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
    stat: options?.stat ?? fs.stat,
    readFile: options?.readFile ?? fs.readFile,
    utimes: options?.utimes ?? fs.utimes,
  };
  const staleMs = options?.staleMs ?? LOCK_STALE_MS;
  const ownerToken = await acquireLock(
    lockPath,
    options?.timeoutMs ?? LOCK_TIMEOUT_MS,
    ops,
    staleMs
  );
  const heartbeat = setInterval(() => {
    void ops
      .readFile(lockPath, "utf8")
      .then((currentToken) => {
        if (currentToken !== ownerToken) return;
        const now = new Date();
        return ops.utimes(lockPath, now, now);
      })
      .catch(() => undefined);
  }, staleMs / 3);
  heartbeat.unref();

  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    await releaseLock(lockPath, ownerToken, ops);
  }
}
