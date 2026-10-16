import { getGitTrackedFiles } from "./GitUtils";
import { Log } from "./Log";
import {
  DEFAULT_SKIP_DIRECTORIES,
  walkSearchFiles,
} from "./WorkspaceSearchFileWalker";

/** How long a source-file list is reused by the symbol indexes. */
const SOURCE_FILES_TTL_MS = 5_000;

/** Return Git-visible source paths for symbol indexes, with a safe walk fallback. */
export async function getSourceFiles(rootPath: string): Promise<string[]> {
  try {
    return await getGitTrackedFiles(rootPath);
  } catch (error) {
    Log.warn(
      `[Completions] git ls-files failed for ${rootPath}, falling back to workspace walk:`,
      error
    );
    return walkAndLog(rootPath);
  }
}

/** A memoized source-file lister; `invalidate` forces the next call to re-list. */
export interface CachedSourceFiles {
  (): Promise<string[]>;
  invalidate(): void;
}

/**
 * Wrap a source-file lister so concurrent callers share one listing and
 * repeated symbol queries (one per `#` keystroke) reuse it briefly instead of
 * spawning `git ls-files` each time.
 */
export function cacheSourceFiles(
  load: () => Promise<string[]>,
  ttlMs = SOURCE_FILES_TTL_MS
): CachedSourceFiles {
  let cached: { at: number; files: Promise<string[]> } | undefined;
  const get = (): Promise<string[]> => {
    if (!cached || Date.now() - cached.at >= ttlMs) {
      const files = load();
      const entry = { at: Date.now(), files };
      cached = entry;
      files.catch(() => {
        if (cached === entry) cached = undefined;
      });
    }
    return cached.files;
  };
  return Object.assign(get, {
    invalidate: () => {
      cached = undefined;
    },
  });
}

async function walkAndLog(rootPath: string): Promise<string[]> {
  const { files } = await walkSearchFiles(
    rootPath,
    Date.now(),
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    DEFAULT_SKIP_DIRECTORIES,
    true
  );
  // Git reports forward slashes; match it so every host receives one path form.
  return files.map((file) => file.replace(/\\/g, "/"));
}
