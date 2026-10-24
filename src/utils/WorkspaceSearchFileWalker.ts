import * as fs from "fs/promises";
import * as path from "path";
import type { Dirent } from "fs";

export const DEFAULT_SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
]);

/** Shared completion-search exclusion used by both the walker and file watcher. */
export function isSearchPathIgnored(
  relativePath: string,
  skipDirectories: ReadonlySet<string> = DEFAULT_SKIP_DIRECTORIES,
  excludeCtrlYokeLogs = true
): boolean {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  return (
    segments.some((segment) => skipDirectories.has(segment)) ||
    (excludeCtrlYokeLogs &&
      segments.length >= 2 &&
      segments[0] === ".ctrlyoke" &&
      segments[1] === "logs")
  );
}

/** Paths intentionally exposed when completion search includes gitignored files. */
export const COMPLETION_ALL_FILES_SKIP_DIRECTORIES = new Set([".git"]);

export interface SearchWalkResult {
  files: string[];
  truncated: boolean;
}

/**
 * Bounded non-git fallback walk. Symlinks are not followed. Breadth-first, so
 * a walk cut short by either bound loses the deepest paths rather than whole
 * top-level directories (a depth-first walk exhausted the cap inside one huge
 * tree such as `.vscode-test/` and never reached `.github/`).
 */
export async function walkSearchFiles(
  rootPath: string,
  startedAt: number,
  maxFiles: number,
  maxDurationMs: number,
  skipDirectories: ReadonlySet<string> = DEFAULT_SKIP_DIRECTORIES,
  excludeCtrlYokeLogs = true,
  /** Receives each directory's files as they are found, before the walk ends. */
  onFiles?: (files: readonly string[]) => void,
  /** Stops the walk before its next directory, reporting it truncated. */
  signal?: AbortSignal
): Promise<SearchWalkResult> {
  const root = path.resolve(rootPath);
  const pending = [root];
  let next = 0;
  const files: string[] = [];
  let truncated = false;

  while (next < pending.length && files.length < maxFiles) {
    if (Date.now() - startedAt >= maxDurationMs || signal?.aborted) {
      truncated = true;
      break;
    }
    const directory = pending[next++];
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    const firstNewFile = files.length;
    for (const entry of entries) {
      if (Date.now() - startedAt >= maxDurationMs) {
        truncated = true;
        break;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (
        entry.isDirectory() &&
        !skipDirectories.has(entry.name) &&
        !isSearchPathIgnored(
          path.relative(root, path.join(directory, entry.name)),
          skipDirectories,
          excludeCtrlYokeLogs
        )
      ) {
        pending.push(path.join(directory, entry.name));
      } else if (entry.isFile()) {
        files.push(path.relative(root, path.join(directory, entry.name)));
      }
    }
    if (onFiles && files.length > firstNewFile) {
      onFiles(files.slice(firstNewFile));
    }
  }
  if (files.length >= maxFiles && next < pending.length) {
    truncated = true;
  }
  return { files, truncated };
}

/**
 * Pull-driven counterpart to `walkSearchFiles`: the same breadth-first,
 * symlink-free walk, yielding each directory's files (relative to `rootPath`)
 * as it reads them and doing no more work than the consumer pulls. It has no
 * bounds of its own; a caller that stops iterating stops the walk.
 *
 * `startDirectories` (relative to `rootPath`) seeds the walk somewhere other
 * than the root, e.g. only the directories Git reports as wholly ignored.
 */
export async function* iterateSearchFiles(
  rootPath: string,
  startDirectories: readonly string[] = [""],
  skipDirectories: ReadonlySet<string> = DEFAULT_SKIP_DIRECTORIES,
  excludeCtrlYokeLogs = true
): AsyncGenerator<string[]> {
  const root = path.resolve(rootPath);
  const pending = startDirectories.map((directory) =>
    path.resolve(root, directory)
  );
  for (let next = 0; next < pending.length; next++) {
    const directory = pending[next];
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    const files: string[] = [];
    for (const entry of entries) {
      const relativePath = path.relative(
        root,
        path.join(directory, entry.name)
      );
      if (
        entry.isDirectory() &&
        !skipDirectories.has(entry.name) &&
        !isSearchPathIgnored(relativePath, skipDirectories, excludeCtrlYokeLogs)
      ) {
        pending.push(path.join(directory, entry.name));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
    if (files.length > 0) yield files;
  }
}
