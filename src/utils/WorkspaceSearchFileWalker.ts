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
  excludeCtrlYokeLogs = true
): Promise<SearchWalkResult> {
  const root = path.resolve(rootPath);
  const pending = [root];
  let next = 0;
  const files: string[] = [];
  let truncated = false;

  while (next < pending.length && files.length < maxFiles) {
    if (Date.now() - startedAt >= maxDurationMs) {
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
  }
  if (files.length >= maxFiles && next < pending.length) {
    truncated = true;
  }
  return { files, truncated };
}
