import * as fs from "fs/promises";
import * as path from "path";
import type { Dirent } from "fs";

const DEFAULT_SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
]);

export interface SearchWalkResult {
  files: string[];
  truncated: boolean;
}

/** Bounded non-git fallback walk. Symlinks are not followed. */
export async function walkSearchFiles(
  rootPath: string,
  startedAt: number,
  maxFiles: number,
  maxDurationMs: number,
  skipDirectories: ReadonlySet<string> = DEFAULT_SKIP_DIRECTORIES
): Promise<SearchWalkResult> {
  const root = path.resolve(rootPath);
  const pending = [root];
  const files: string[] = [];
  let truncated = false;

  while (pending.length > 0 && files.length < maxFiles) {
    if (Date.now() - startedAt >= maxDurationMs) {
      truncated = true;
      break;
    }
    const directory = pending.pop();
    if (!directory) break;
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
      if (entry.isDirectory() && !skipDirectories.has(entry.name)) {
        pending.push(path.join(directory, entry.name));
      } else if (entry.isFile()) {
        files.push(path.relative(root, path.join(directory, entry.name)));
      }
    }
  }
  if (files.length >= maxFiles && pending.length > 0) {
    truncated = true;
  }
  return { files, truncated };
}
