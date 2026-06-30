import * as fs from "fs";
import * as path from "path";

export interface WorkflowFileEntry {
  path: string;
  relativePath: string;
  /** True if this file is ignored by .gitignore. Only set by hosted-server callers. */
  gitIgnored?: boolean;
}

const WORKFLOW_FILE_NAMES = new Set([
  "ctrlyoke.json",
  "ctrlyoke.yaml",
  "ctrlyoke.yml",
  "prompt.md",
]);

const WORKFLOW_FILE_SUFFIXES = [
  ".ctrlyoke.json",
  ".ctrlyoke.yaml",
  ".ctrlyoke.yml",
  ".prompt.md",
];

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

function isWorkflowFileName(fileName: string): boolean {
  return (
    WORKFLOW_FILE_NAMES.has(fileName) ||
    WORKFLOW_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix))
  );
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
        if (!IGNORED_WORKFLOW_SCAN_DIRS.has(entry.name)) {
          visit(fullPath);
        }
        continue;
      }

      if (!isWorkflowFileName(entry.name)) {
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
