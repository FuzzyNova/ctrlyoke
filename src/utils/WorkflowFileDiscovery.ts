import * as fs from "fs/promises";
import * as path from "path";
import { getCtrlYokeFileKind } from "../completions/CtrlYokeFileKind";
import {
  getGitFilesIncludingNestedRepos,
  getGitIgnoredEntries,
  isNotGitRepositoryError,
} from "./GitUtils";
import { iterateSearchFiles } from "./WorkspaceSearchFileWalker";
import { BUNDLE_MANIFEST_FILE_NAME } from "../types/DashboardConstants";

export interface WorkflowFileEntry {
  path: string;
  relativePath: string;
  /** True if Git reports the file as ignored; available for Git-backed discovery. */
  gitIgnored?: boolean;
}

const IGNORED_WORKFLOW_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "coverage",
]);

export interface WorkflowFileDiscoveryOptions {
  /** Include ignored workflow files for the picker's opt-in display mode. */
  includeGitIgnored?: boolean;
}

function toPortablePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

async function isManifestedBundleAsset(
  workspaceRoot: string,
  relativePath: string,
  cache: Map<string, Promise<boolean>>
): Promise<boolean> {
  const segments = relativePath.split(/[\\/]/);
  let directory = workspaceRoot;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    if (!segment.endsWith(".assets")) continue;
    let manifested = cache.get(directory);
    if (!manifested) {
      manifested = fs
        .access(path.join(directory, BUNDLE_MANIFEST_FILE_NAME))
        .then(() => true, () => false);
      cache.set(directory, manifested);
    }
    if (await manifested) return true;
  }
  return false;
}

/**
 * Find workflow files without synchronously walking a workspace. Git checkouts
 * use Git's tracked and non-ignored untracked paths (including nested repos);
 * non-repository folders use a yielding filesystem walk.
 */
export async function findWorkflowFilesInWorkspace(
  workspaceRoot: string,
  options: WorkflowFileDiscoveryOptions = {}
): Promise<WorkflowFileEntry[]> {
  const root = path.resolve(workspaceRoot);
  const entries: Array<{ relativePath: string; gitIgnored?: boolean }> = [];

  try {
    for await (const chunk of getGitFilesIncludingNestedRepos(root)) {
      for (const gitPath of chunk) {
        const relativePath = toPortablePath(gitPath);
        if (getCtrlYokeFileKind(path.basename(relativePath)) === null) continue;
        entries.push({ relativePath, gitIgnored: false });
      }
    }
    if (options.includeGitIgnored) {
      const ignored = await getGitIgnoredEntries(root);
      const ignoredFiles = ignored.filter((entry) => !entry.endsWith("/"));
      const ignoredDirectories = ignored
        .filter((entry) => entry.endsWith("/"))
        .map((entry) => entry.slice(0, -1));
      for (const entry of ignoredFiles) {
        const relativePath = toPortablePath(entry);
        if (getCtrlYokeFileKind(path.basename(relativePath)) !== null) {
          entries.push({ relativePath, gitIgnored: true });
        }
      }
      for await (const files of iterateSearchFiles(
        root,
        ignoredDirectories,
        IGNORED_WORKFLOW_SCAN_DIRS,
        false
      )) {
        for (const file of files) {
          const relativePath = toPortablePath(file);
          if (getCtrlYokeFileKind(path.basename(relativePath)) !== null) {
            entries.push({ relativePath, gitIgnored: true });
          }
        }
      }
    }
  } catch (error) {
    if (!isNotGitRepositoryError(error)) throw error;
    for await (const files of iterateSearchFiles(
      root,
      [""],
      IGNORED_WORKFLOW_SCAN_DIRS,
      false
    )) {
      for (const file of files) {
        const relativePath = toPortablePath(file);
        if (getCtrlYokeFileKind(path.basename(relativePath)) !== null) {
          entries.push({ relativePath });
        }
      }
    }
  }

  const manifestedDirectories = new Map<string, Promise<boolean>>();
  const files: WorkflowFileEntry[] = [];
  for (const entry of entries) {
    if (
      await isManifestedBundleAsset(
        root,
        entry.relativePath,
        manifestedDirectories
      )
    ) {
      continue;
    }
    files.push({
      path: toPortablePath(path.resolve(root, entry.relativePath)),
      relativePath: entry.relativePath,
      ...(entry.gitIgnored === undefined
        ? {}
        : { gitIgnored: entry.gitIgnored }),
    });
  }

  const unique = new Map(files.map((file) => [file.relativePath, file]));
  return Array.from(unique.values()).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
}
