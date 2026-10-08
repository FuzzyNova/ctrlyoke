import * as fs from "fs";
import * as path from "path";
import { getCtrlYokeFileKind } from "../completions/CtrlYokeFileKind";
import { BUNDLE_MANIFEST_FILE_NAME } from "../types/DashboardConstants";

export interface WorkflowFileEntry {
  path: string;
  relativePath: string;
  /** True if this file is ignored by .gitignore. Only set by hosted-server callers. */
  gitIgnored?: boolean;
}

const IGNORED_WORKFLOW_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "coverage",
]);

function toPortablePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function findWorkflowFilesInWorkspace(
  workspaceRoot: string
): WorkflowFileEntry[] {
  const results: WorkflowFileEntry[] = [];

  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const isBundleAssetsDirectory =
          entry.name.endsWith(".assets") &&
          fs.existsSync(path.join(fullPath, BUNDLE_MANIFEST_FILE_NAME));
        if (
          !IGNORED_WORKFLOW_SCAN_DIRS.has(entry.name) &&
          !isBundleAssetsDirectory
        ) {
          visit(fullPath);
        }
        continue;
      }

      if (getCtrlYokeFileKind(entry.name) === null) {
        continue;
      }

      results.push({
        path: toPortablePath(fullPath),
        relativePath: toPortablePath(path.relative(workspaceRoot, fullPath)),
      });
    }
  };

  visit(workspaceRoot);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
