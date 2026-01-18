import * as fs from "fs/promises";

const LOCK_FILE_EXTENSION = ".lock";
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_STALE_MS = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath: string): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        const payload = `${process.pid} ${new Date().toISOString()}`;
        await handle.writeFile(payload, "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch {}

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Timed out waiting for lock: ${lockPath}`);
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch {}
}

export async function withFileLock<T>(
  targetPath: string,
  action: () => Promise<T>
): Promise<T> {
  const lockPath = `${targetPath}${LOCK_FILE_EXTENSION}`;
  await acquireLock(lockPath);

  try {
    return await action();
  } finally {
    await releaseLock(lockPath);
  }
}
