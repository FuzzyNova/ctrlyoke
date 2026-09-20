import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Single source for the mkdtemp+cleanup pattern used throughout src/test/**.
 *
 * Cleanup is best-effort and never throws: Windows can hold transient locks
 * on files a test just wrote (git pack files, antivirus scans), so deleting
 * retries briefly and then gives up silently rather than failing an
 * otherwise-green run. Anything that survives a crash or a kill before this
 * runs is swept up by scripts/clean-stale-test-temp.mjs at the start of the
 * next `npm test`.
 */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(
  dir: string | undefined | null,
  onFailure?: (dir: string) => void
): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  } catch {
    // Best-effort cleanup of OS temp dirs; ignore residual lock failures.
    onFailure?.(dir);
  }
}
