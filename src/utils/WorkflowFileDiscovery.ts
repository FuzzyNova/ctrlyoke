import * as fs from "fs";
import * as path from "path";

export interface WorkflowFileEntry {
  path: string;
  relativePath: string;
}

export const WORKFLOW_FILE_GLOB =
  "**/*.{flightpath.json,flightpath.yaml,flightpath.yml,prompt.md}";

export const WORKFLOW_FILE_EXCLUDE_GLOB = "**/node_modules/**";

const WORKFLOW_FILE_NAMES = new Set([
  "flightpath.json",
  "flightpath.yaml",
  "flightpath.yml",
  "prompt.md",
]);

const WORKFLOW_FILE_SUFFIXES = [
  ".flightpath.json",
  ".flightpath.yaml",
  ".flightpath.yml",
  ".prompt.md",
];

const IGNORED_WORKFLOW_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "coverage",
]);

export function isWorkflowFileName(fileName: string): boolean {
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
        path: fullPath,
        relativePath: path.relative(workspaceRoot, fullPath),
      });
    }
  };

  visit(workspaceRoot);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
