import * as vscode from "vscode";
import * as fs from "fs";
import { pathsEqual } from "./PathCasing";

/**
 * DiscoveryUtils
 *
 * Shared helpers for agent and skill discovery.
 * Used by AgentDiscovery, SkillDiscovery, AgentExpander, and SkillExpander.
 */

/**
 * Format a directory or filename for display in UI.
 * Converts kebab-case or snake_case to Title Case.
 *
 * @example formatDisplayName("pdf-processing") → "Pdf Processing"
 * @example formatDisplayName("my_skill")       → "My Skill"
 */
export function formatDisplayName(name: string): string {
  const withSpaces = name.replace(/[-_]/g, " ");
  return withSpaces
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Returns true if `directoryPath` exists and is a directory.
 * Returns false for any other case (missing, file, permission error).
 */
export async function isAccessibleDirectory(
  directoryPath: string
): Promise<boolean> {
  if (!fs.existsSync(directoryPath)) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a VS Code WorkspaceFolder from an optional workspace root path.
 *
 * Resolution order:
 *  1. If `workspaceRoot` is provided, find the folder whose `fsPath` matches exactly.
 *  2. Fall back to the first open workspace folder.
 *  3. Return undefined if no workspace folders are open.
 */
export function resolveWorkspaceFolder(
  workspaceRoot?: string
): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (workspaceRoot) {
    return (
      folders.find((folder) => pathsEqual(folder.uri.fsPath, workspaceRoot)) ??
      folders[0]
    );
  }
  return folders[0];
}
