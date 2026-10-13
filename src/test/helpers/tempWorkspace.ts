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

/**
 * Unlinks every symlink and directory junction under `dir`, leaving their
 * targets alone. The extension tests run on Electron's Node 24, whose
 * recursive `fs.rmSync` descends *through* a Windows junction and deletes the
 * target's contents. A test that junctioned the repo's own
 * `node_modules/typescript` into its temp workspace emptied it on every run.
 * Returns false when a link could not be removed, so the caller must not
 * recurse over the tree.
 */
function unlinkLinksInTree(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  let allUnlinked = true;
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      try {
        fs.unlinkSync(entryPath);
      } catch {
        allUnlinked = false;
      }
    } else if (stat.isDirectory() && !unlinkLinksInTree(entryPath)) {
      allUnlinked = false;
    }
  }
  return allUnlinked;
}

export function removeTempDir(
  dir: string | undefined | null,
  onFailure?: (dir: string) => void
): void {
  if (!dir) return;
  try {
    if (!unlinkLinksInTree(dir)) {
      // A link survived; recursing would delete through it into its target.
      onFailure?.(dir);
      return;
    }
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
