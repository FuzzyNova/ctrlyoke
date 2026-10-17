import { promises as fs } from "fs";
import * as path from "path";
import { Log } from "./Log";
import { RealpathContainmentChecker } from "./PathSecurity";
import {
  resolveReferencePath,
  type ResolverWorkspaceFolder,
} from "../platform/WorkspaceRootResolver";

/**
 * Utility functions for building XML attachments for various reference types
 */

/**
 * Build a directory tree structure as a string
 *
 * @param dirPath Absolute path of the directory to scan
 * @param maxDepth Maximum depth to scan (default: 3)
 * @param currentDepth Internal recursion tracker
 * @param prefix Internal line prefix for tree formatting
 * @returns Formatted directory tree string
 */
async function buildDirectoryTree(
  dirPath: string,
  maxDepth: number = 3,
  currentDepth: number = 0,
  prefix: string = ""
): Promise<string> {
  if (currentDepth >= maxDepth) {
    return "";
  }

  try {
    // Symlinks are listed but never followed (a link's Dirent is not a
    // directory), so a link cycle cannot recurse.
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    // Sort: directories first, then files, alphabetically
    entries.sort((a, b) => {
      const aIsDir = a.isDirectory();
      const bIsDir = b.isDirectory();

      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.name.localeCompare(b.name);
    });

    let tree = "";
    const lastIndex = entries.length - 1;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const name = entry.name;
      const isLast = i === lastIndex;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (entry.isDirectory()) {
        tree += `${prefix}${connector}${name}/\n`;

        // Recurse into subdirectory
        const subTree = await buildDirectoryTree(
          path.join(dirPath, name),
          maxDepth,
          currentDepth + 1,
          prefix + childPrefix
        );
        tree += subTree;
      } else {
        tree += `${prefix}${connector}${name}\n`;
      }
    }

    return tree;
  } catch (error) {
    Log.warn(
      `[AttachmentBuilders] Failed to read directory ${dirPath}; returning partial tree:`,
      error
    );
    return `${prefix}[Error reading directory]\n`;
  }
}

/**
 * Build XML attachment for a directory structure
 *
 * @param dirPath Workspace-relative directory path (with or without trailing slash),
 *   optionally folder-name-prefixed for multi-root (`root2/src/`)
 * @param workspaceRoot Absolute path to workspace root, used to resolve relative refs
 * @param additionalTrustedRoots Extra absolute directories to also trust (e.g. every
 *   folder of a multi-root `.code-workspace`, which need not be descendants of
 *   `workspaceRoot`). Defaults to just `workspaceRoot`.
 * @param namedRoots Named roots for folder-name-prefixed resolution (see
 *   `resolveReferencePath`). Defaults to none (primary-root-only resolution).
 * @param effectiveAbsolute When true, render the resolved absolute directory path
 *   in the attachment body instead of the as-typed relative path (the id is
 *   unaffected — it only needs to be stable for deduplication).
 * @param sourceDefinitionDir Directory containing the authored workflow, used
 *   for `./` and `../` references.
 * @returns XML string with directory tree
 */
export async function buildDirectoryAttachmentXml(
  dirPath: string,
  workspaceRoot: string,
  additionalTrustedRoots: string[] = [],
  namedRoots: ResolverWorkspaceFolder[] = [],
  effectiveAbsolute: boolean = false,
  sourceDefinitionDir?: string,
  containmentChecker?: RealpathContainmentChecker
): Promise<string> {
  // Remove trailing slash for consistent path handling
  const normalizedPath = dirPath.replace(/[/\\]+$/, "");

  // Build absolute URI
  const resolvedRoot = path.resolve(workspaceRoot);
  const absolutePath = resolveReferencePath(normalizedPath, {
    primaryRoot: resolvedRoot,
    namedRoots,
    sourceDefinitionDir,
  }).absolutePath;
  const trustedRoots = [
    resolvedRoot,
    ...additionalTrustedRoots.map((root) => path.resolve(root)),
  ];
  const checker =
    containmentChecker ?? new RealpathContainmentChecker(trustedRoots);

  // @dir/ references come from prompt/workflow file content, which may not
  // have been authored by the person running it — reject traversal outside
  // every trusted root rather than listing an arbitrary directory on disk.
  const containment = await checker.check(absolutePath);
  if (!containment.allowed) {
    Log.warn(
      `[AttachmentBuilders] Security: Directory reference "${dirPath}" resolves outside the workspace and was blocked: "${containment.resolvedPath}"`
    );
    throw new Error(
      `Directory reference resolves outside the workspace and was blocked: "${containment.resolvedPath}". Add the target folder to permissions.trustedExternalRoots to allow it`
    );
  }
  const authorizedPath = containment.resolvedPath;

  // Check if directory exists
  try {
    const stat = await fs.stat(authorizedPath);
    if (!stat.isDirectory()) {
      throw new Error("Path is not a directory");
    }
  } catch (error) {
    Log.warn(`[AttachmentBuilders] Directory not found: ${dirPath}`, error);
    throw new Error(`Directory not found: ${normalizedPath}`);
  }

  // Build tree
  const tree = await buildDirectoryTree(authorizedPath);
  const fileCount = (tree.match(/\n/g) || []).length;

  const displayPath = effectiveAbsolute ? authorizedPath : normalizedPath;

  return `<attachment id="directory:${normalizedPath}">
Directory structure: ${displayPath}/ (${fileCount} items)

${displayPath}/
${tree}
</attachment>`;
}
